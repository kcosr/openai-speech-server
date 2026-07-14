import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config, SpeechModelConfig, TranscriptionModelConfig } from "../config/schema.js";
import { ApiError, errorBody, invalid } from "./errors.js";
import { Authenticator, type Client } from "../auth/auth.js";
import { Registry } from "../runtime/registry.js";
import { ClientAdmission } from "../runtime/admission.js";
import { normalizeUpload, storeUpload } from "../media/normalize.js";
import { Metrics } from "../observability/metrics.js";

declare module "fastify" { interface FastifyRequest { client: Client; requestAbort: AbortController } }

const SpeechBody = z.object({
  model: z.string(),
  voice: z.string().optional(),
  input: z.string().min(1),
  response_format: z.enum(["pcm", "wav"]).default("pcm"),
  speed: z.number().positive().optional(),
  instructions: z.string().optional(),
  stream_format: z.string().optional(),
  extensions: z.record(z.string(), z.json()).optional(),
}).passthrough();
const SPEECH_FIELDS = new Set(["model", "voice", "input", "response_format", "speed", "instructions", "stream_format", "extensions"]);
const TRANSCRIPTION_FIELDS = new Set(["model", "language", "prompt", "response_format", "stream", "temperature", "extensions"]);

export async function buildApp(config: Config, authenticator: Authenticator, registry = new Registry(config)): Promise<FastifyInstance> {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "headers.authorization"] }, genReqId: () => `req_${randomUUID().replaceAll("-", "")}` });
  const admission = new ClientAdmission(); const metrics = new Metrics();
  await app.register(multipart, { limits: { fileSize: config.server.max_upload_bytes, files: 1, fields: 16 } });
  app.decorateRequest("client"); app.decorateRequest("requestAbort");
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id); reply.raw.setHeader("X-Request-Id", request.id);
    request.requestAbort = new AbortController();
    request.raw.once("aborted", () => request.requestAbort.abort(clientDisconnected("upload")));
    reply.raw.once("close", () => { if (!reply.raw.writableFinished) request.requestAbort.abort(clientDisconnected("response")); });
    if (!request.url.startsWith("/health/")) request.client = authenticator.authenticate(request.headers.authorization);
  });
  app.setErrorHandler((raw, request, reply) => {
    const framework = raw as Error & { statusCode?: number; code?: string };
    const error = raw instanceof ApiError ? raw : raw instanceof z.ZodError ? invalid("invalid_request", raw.issues.map((i) => i.message).join("; ")) : framework.statusCode && framework.statusCode >= 400 && framework.statusCode < 500 ? new ApiError(framework.statusCode, "invalid_request_error", framework.code === "FST_REQ_FILE_TOO_LARGE" ? "upload_too_large" : framework.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? "invalid_json" : framework.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "unsupported_media_type" : "invalid_request", framework.statusCode === 413 ? "Audio upload exceeds the configured limit." : "The request could not be parsed.") : new ApiError(500, "server_error", "internal_error", "Internal server error.");
    if (error.status >= 500) error.code === "request_timeout" || error.code === "first_byte_timeout" ? request.log.warn(raw) : request.log.error(raw);
    if (error.retryAfter) reply.header("Retry-After", error.retryAfter);
    reply.code(error.status).send(errorBody(error, request.id));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(new ApiError(404, "invalid_request_error", "not_found", "Not found."), request.id)));
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => { const failed = [...registry.models.values()].filter(({ config: model, provider }) => model.required && !provider.ready); return failed.length ? reply.code(503).send({ status: "not_ready", providers: failed.map(({ config: model, provider }) => ({ model: model.id, state: provider.state })) }) : { status: "ready" }; });
  app.get("/v1/models", async (request) => ({ object: "list", data: registry.visible(request.client).map(({ config: model }) => ({ id: model.id, object: "model", created: 0, owned_by: "openai-speech-server" })) }));
  app.get("/v1/audio/capabilities", async (request) => registry.capabilities(request.client));
  app.get("/metrics", async (_request, reply) => {
    if (!config.server.metrics_enabled) throw new ApiError(404, "invalid_request_error", "not_found", "Not found.");
    metrics.providerState.reset();
    for (const [id, runtime] of registry.models) { metrics.queue.set({ model: id }, runtime.queue.depth); metrics.workerRestarts.set({ model: id }, runtime.provider.restartCount); metrics.providerState.set({ model: id, state: runtime.provider.state }, 1); }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  app.post("/v1/audio/transcriptions", async (request, reply) => withAdmission(request, admission, config.server.request_timeout_seconds * 1000, async (signal) => {
    if (!request.isMultipart()) throw invalid("invalid_content_type", "Expected multipart/form-data.");
    const fields: Record<string, string> = {}; let upload: Awaited<ReturnType<typeof storeUpload>> | undefined; let modelRuntime;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") { if (typeof part.value !== "string") throw invalid("invalid_field", `Invalid field '${part.fieldname}'.`, part.fieldname); fields[part.fieldname] = part.value; }
        else { if (part.fieldname !== "file" || upload) throw invalid("invalid_file", "Exactly one 'file' part is required.", "file"); upload = await storeUpload(part, { directory: config.server.temp_directory, maxBytes: config.server.max_upload_bytes }, signal); }
      }
      if (!upload) throw invalid("missing_file", "A file is required.", "file");
      if (!fields.model) throw invalid("missing_model", "A model is required.", "model");
      modelRuntime = registry.resolve(fields.model, "transcription", request.client);
      const format = fields.response_format ?? "json"; if (!["json", "text"].includes(format)) throw invalid("unsupported_response_format", `Unsupported response format '${format}'.`, "response_format");
      const stream = parseBooleanField(fields.stream, "stream") ?? false;
      if (stream && format !== "json") throw invalid("unsupported_response_format", "Streaming transcription requires response_format 'json'.", "response_format");
      const model = modelRuntime.config as TranscriptionModelConfig;
      if (!model.input_formats.includes(upload.format)) throw new ApiError(415, "invalid_request_error", "unsupported_media_type", `Input format '${upload.format}' is not supported by this model.`, "file");
      const ignored = [...Object.keys(fields).filter((field) => !TRANSCRIPTION_FIELDS.has(field)), ...(fields.temperature === undefined ? [] : ["temperature"]), ...(fields.prompt && !model.supports_prompt ? ["prompt"] : [])];
      warnIgnoredFields(request, "/v1/audio/transcriptions", ignored);
      const extensions = modelRuntime.extensions.validate(parseMultipartExtensions(fields.extensions));
      const normalized = await normalizeUpload(upload, { ffmpeg: config.server.ffmpeg, prlimit: config.server.prlimit, memoryBytes: config.server.ffmpeg_memory_bytes, timeoutMs: config.server.normalization_timeout_seconds * 1000, maxOutputBytes: config.server.max_upload_bytes }, signal);
      if (model.max_duration_seconds && normalized.durationSeconds > model.max_duration_seconds) throw invalid("audio_too_long", `Audio exceeds the ${model.max_duration_seconds} second model limit.`, "file");
      const release = await modelRuntime.queue.acquire(signal);
      try {
        const result = await registry.transcription(modelRuntime).transcribe({ path: normalized.path, ...(fields.language ? { language: fields.language } : {}), ...(fields.prompt && model.supports_prompt ? { prompt: fields.prompt } : {}), ...(extensions ? { extensions } : {}) }, signal);
        if (stream) return reply.type("text/event-stream; charset=utf-8").header("Cache-Control", "no-cache").send(transcriptionSse(result.text));
        return format === "text" ? reply.type("text/plain; charset=utf-8").send(result.text) : result;
      }
      finally { release(); }
    } finally { await upload?.cleanup(); }
  }));

  app.post("/v1/audio/speech", async (request, reply) => withAdmission(request, admission, 0, async (disconnectSignal) => {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "invalid_request_error", "unsupported_media_type", "Expected application/json.");
    const body = SpeechBody.parse(request.body); const runtime = registry.resolve(body.model, "speech", request.client); const model = runtime.config as SpeechModelConfig;
    if (body.input.length > model.max_text_length) throw invalid("input_too_long", "Input exceeds the model text limit.", "input");
    if (body.stream_format !== undefined && body.stream_format !== "audio") throw invalid("unsupported_stream_format", `Stream format '${body.stream_format}' is not supported.`, "stream_format");
    const extensions = runtime.extensions.validate(body.extensions);
    const ignored = [...Object.keys(body).filter((field) => !SPEECH_FIELDS.has(field)), ...(body.instructions === undefined ? [] : ["instructions"])];
    warnIgnoredFields(request, "/v1/audio/speech", ignored);
    const voice = registry.resolveVoice(model, request.client, body.voice); const speed = body.speed ?? model.speed.default;
    if (!model.output_formats.includes(body.response_format)) throw invalid("unsupported_response_format", `Format '${body.response_format}' is not supported.`, "response_format");
    if (speed < model.speed.min || speed > model.speed.max) throw invalid("unsupported_speed", `Speed must be between ${model.speed.min} and ${model.speed.max}.`, "speed");
    const streamAbort = new AbortController(); const signal = AbortSignal.any([disconnectSignal, streamAbort.signal]);
    const firstByteTimer = setTimeout(() => streamAbort.abort(new ApiError(504, "server_error", "first_byte_timeout", "Synthesis did not produce audio before the timeout.")), config.server.request_timeout_seconds * 1000);
    const release = await runtime.queue.acquire(signal); let started = false; let iterator: AsyncIterator<Buffer> | undefined;
    try {
      const chunks = registry.speech(runtime).synthesize({ input: body.input, voice, speed, format: body.response_format, ...(extensions ? { extensions } : {}) }, signal);
      iterator = chunks[Symbol.asyncIterator]();
      while (true) {
        const idleTimer = started ? setTimeout(() => streamAbort.abort(new Error("Stream idle timeout")), config.server.stream_idle_timeout_seconds * 1000) : undefined;
        const next = await iterator.next(); if (idleTimer) clearTimeout(idleTimer);
        if (next.done) { if (signal.aborted) throw signal.reason; break; }
        if (!started) { started = true; clearTimeout(firstByteTimer); reply.raw.setHeader("Content-Type", body.response_format === "pcm" ? `audio/pcm; rate=${model.sample_rate}; channels=${model.channels}; format=s16le` : "audio/wav"); }
        if (!reply.raw.write(next.value)) await waitForDrain(reply.raw, signal, config.server.stream_idle_timeout_seconds * 1000, streamAbort);
      }
      reply.raw.end(); return reply;
    } catch (error) { if (started || reply.raw.headersSent) { reply.raw.destroy(error as Error); return reply; } throw error; }
    finally { clearTimeout(firstByteTimer); await iterator?.return?.(); release(); }
  }));

  app.addHook("onResponse", async (request, reply) => { const route = request.routeOptions.url ?? "unknown"; metrics.requests.inc({ route, status: String(reply.statusCode) }); metrics.duration.observe({ route }, reply.elapsedTime / 1000); });
  app.addHook("onClose", async () => registry.stop());
  return app;
}

function waitForDrain(response: import("node:http").ServerResponse, signal: AbortSignal, timeoutMs: number, controller: AbortController): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); response.off("drain", drained); response.off("close", closed); signal.removeEventListener("abort", aborted); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("Response closed during backpressure")); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => controller.abort(new Error("Response backpressure timeout")), timeoutMs);
    response.once("drain", drained); response.once("close", closed); signal.addEventListener("abort", aborted, { once: true });
  });
}

async function withAdmission<T>(request: FastifyRequest, admission: ClientAdmission, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const release = admission.acquire(request.client.id, request.client.max_concurrent_requests);
  const timeout = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => timeout.abort(new ApiError(504, "server_error", "request_timeout", "Request processing timed out.")), timeoutMs) : undefined;
  timer?.unref();
  const signal = timer ? AbortSignal.any([request.requestAbort.signal, timeout.signal]) : request.requestAbort.signal;
  try { return await work(signal); } finally { if (timer) clearTimeout(timer); release(); }
}

function clientDisconnected(phase: string): ApiError {
  return new ApiError(499, "invalid_request_error", "client_disconnected", `Client disconnected during ${phase}.`);
}

function parseBooleanField(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid("invalid_field", `Field '${field}' must be 'true' or 'false'.`, field);
}

function parseMultipartExtensions(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid("invalid_extensions", "Field 'extensions' must contain a JSON object.", "extensions"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("invalid_extensions", "Field 'extensions' must contain a JSON object.", "extensions");
  return parsed as Record<string, unknown>;
}

function warnIgnoredFields(request: FastifyRequest, route: string, fields: readonly string[]) {
  const unique = [...new Set(fields)].sort();
  if (unique.length > 0) request.log.warn({ route, fields: unique }, "Ignoring unsupported OpenAI-compatible request fields");
}

function transcriptionSse(text: string): string {
  return `data: ${JSON.stringify({ type: "transcript.text.done", text })}\n\ndata: [DONE]\n\n`;
}
