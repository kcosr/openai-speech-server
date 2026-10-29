import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket, RawData } from "ws";
import { z } from "zod";
import type { Config, TranscriptionModelConfig } from "../config/schema.js";
import type { Client } from "../auth/auth.js";
import { ClientAdmission } from "../runtime/admission.js";
import { Registry, type ModelRuntime } from "../runtime/registry.js";
import { effectiveRealtimeBufferBytes } from "../runtime/realtime-limits.js";
import { normalizeUpload, type StoredUpload } from "../media/normalize.js";
import { REALTIME_BYTES_PER_SECOND, storeRealtimePcm } from "../media/pcm.js";
import { OggOpusValidator, storeRealtimeOgg } from "../media/ogg-opus.js";
import { ApiError, invalid } from "./errors.js";

const EventId = z.string().max(256).optional();
const Transcription = z.strictObject({ model: z.string().min(1).optional(), language: z.string().min(1).max(128).optional(), prompt: z.string().max(4096).optional() });
const AudioFormat = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("audio/pcm"), rate: z.literal(24000) }),
  z.strictObject({ type: z.literal("audio/ogg"), codec: z.literal("opus") }),
]);
const Update = z.strictObject({
  type: z.literal("session.update"), event_id: EventId,
  session: z.strictObject({
    type: z.literal("transcription"),
    audio: z.strictObject({ input: z.strictObject({
      format: AudioFormat.optional(),
      transcription: Transcription.nullable().optional(), noise_reduction: z.null().optional(), turn_detection: z.null().optional(),
    }).optional() }).optional(),
    include: z.array(z.never()).optional(),
    extensions: z.strictObject({ binary_audio_input: z.strictObject({ version: z.literal(1) }).nullable().optional() }).optional(),
  }),
});
const Append = z.strictObject({ type: z.literal("input_audio_buffer.append"), event_id: EventId, audio: z.string().min(1) });
const Commit = z.strictObject({ type: z.literal("input_audio_buffer.commit"), event_id: EventId });
const Clear = z.strictObject({ type: z.literal("input_audio_buffer.clear"), event_id: EventId });
const ClientEvent = z.discriminatedUnion("type", [Update, Append, Commit, Clear]);
type Settings = { runtime: ModelRuntime; language?: string; prompt?: string };
type InputFormat = z.infer<typeof AudioFormat>;
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const disconnected = () => new ApiError(499, "invalid_request_error", "client_disconnected", "Realtime connection closed.");

/** Authentication is supplied by the normal Fastify hook; admission is shared with HTTP. */
export function registerRealtime(app: FastifyInstance, config: Config, registry: Registry, admission: ClientAdmission) {
  const sessions = new Set<RealtimeSession>();
  const leases = new WeakMap<FastifyRequest, { release: () => void; detach: () => void }>();
  app.route({
    method: "GET", url: "/v1/realtime",
    preValidation: async (request, reply) => {
      if (!request.ws) { reply.header("Upgrade", "websocket").header("Connection", "Upgrade"); throw new ApiError(426, "invalid_request_error", "websocket_required", "A WebSocket upgrade is required."); }
      const query = z.strictObject({ intent: z.literal("transcription") }).safeParse(request.query);
      if (!query.success) throw invalid("unsupported_realtime_mode", "Use /v1/realtime?intent=transcription.", "intent");
      const release = admission.acquire(request.client.id, request.client.max_concurrent_requests);
      // Malformed upgrades can fail after preValidation, before the WS handler owns the lease.
      const detach = () => { request.raw.socket.off("close", release); reply.raw.off("finish", release); };
      request.raw.socket.once("close", release); reply.raw.once("finish", release);
      leases.set(request, { release, detach });
    },
    handler: async (_request, reply) => { reply.header("Upgrade", "websocket").header("Connection", "Upgrade"); throw new ApiError(426, "invalid_request_error", "websocket_required", "A WebSocket upgrade is required."); },
    wsHandler: (socket, request) => {
      const lease = leases.get(request)!; leases.delete(request); lease.detach();
      const session = new RealtimeSession(socket, request.client, request.log, config, registry, lease.release, () => sessions.delete(session));
      sessions.add(session);
      session.start();
    },
  });
  return {
    close() { for (const session of sessions) session.close(1001, "Server shutting down"); },
    async drain() { await Promise.allSettled([...sessions].map((session) => session.settled())); },
  };
}

class RealtimeSession {
  private readonly sessionId = id("sess");
  private readonly expiresAt: number;
  private readonly abort = new AbortController();
  private settings: Settings | undefined;
  private format: InputFormat = { type: "audio/pcm", rate: 24000 };
  private binaryInput = false;
  private buffer: Buffer | undefined;
  private ogg: OggOpusValidator | undefined;
  private bytes = 0;
  private previousItemId: string | null = null;
  private job: Promise<void> | undefined;
  private closed = false;
  private released = false;
  private idle: NodeJS.Timeout | undefined;
  private lifetime: NodeJS.Timeout | undefined;

  constructor(private readonly socket: WebSocket, private readonly client: Client, private readonly log: FastifyBaseLogger, private readonly config: Config, private readonly registry: Registry, private readonly release: () => void, private readonly removed: () => void) {
    this.expiresAt = Math.floor(Date.now() / 1000 + config.server.realtime.max_session_seconds);
  }

  start() {
    // Attach synchronously: clients may send configuration immediately after upgrade.
    this.socket.on("message", (data, binary) => this.receive(data, binary));
    this.socket.once("close", () => this.stop());
    this.socket.on("error", () => this.stop());
    this.lifetime = setTimeout(() => this.close(1000, "Session expired"), this.config.server.realtime.max_session_seconds * 1000);
    this.lifetime.unref(); this.resetIdle();
    this.send({ type: "session.created", session: this.description() });
  }

  private description() {
    return { id: this.sessionId, object: "realtime.transcription_session", type: "transcription", expires_at: this.expiresAt,
      audio: { input: { format: this.format, transcription: this.settings ? { model: this.settings.runtime.config.id, ...(this.settings.language ? { language: this.settings.language } : {}), ...(this.settings.prompt !== undefined ? { prompt: this.settings.prompt } : {}) } : null, noise_reduction: null, turn_detection: null } }, include: [],
      ...(this.binaryInput ? { extensions: { binary_audio_input: { version: 1 } } } : {}) };
  }

  private receive(data: RawData, binary: boolean) {
    if (this.closed) return;
    this.resetIdle();
    let clientEventId: string | undefined;
    try {
      if (binary) {
        if (!this.binaryInput) throw invalid("invalid_event", "Binary audio requires the negotiated binary_audio_input extension.");
        this.appendChunk(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)); return;
      }
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { throw invalid("invalid_json", "The event must be valid JSON."); }
      if (value && typeof value === "object" && "event_id" in value && typeof value.event_id === "string" && value.event_id.length <= 256) clientEventId = value.event_id;
      const parsed = ClientEvent.safeParse(value);
      if (!parsed.success) throw invalid("invalid_event", "Unsupported event, field, or setting. Use supported transcription formats and null turn_detection/noise_reduction.");
      const event = parsed.data;
      if (event.type === "session.update") this.update(event);
      else if (event.type === "input_audio_buffer.append") this.append(event.audio);
      else if (event.type === "input_audio_buffer.clear") { this.clearBuffer(); this.send({ type: "input_audio_buffer.cleared" }); }
      else this.commit();
    } catch (error) {
      const api = publicError(error);
      this.logFailure(api, "client_event");
      this.send({ type: "error", error: { type: api.type, code: api.code, message: api.message, param: api.param ?? null, ...(clientEventId === undefined ? {} : { event_id: clientEventId }) } });
      if (api.code === "audio_buffer_overflow") this.close(1009, "Audio buffer limit exceeded");
    }
  }

  private update(event: z.infer<typeof Update>) {
    if (this.bytes || this.job) throw invalid("session_busy", "Session settings can only change between completed utterances.", "session");
    let settings = this.settings;
    const format = event.session.audio?.input?.format ?? this.format;
    const extension = event.session.extensions?.binary_audio_input;
    const binaryInput = extension === undefined ? this.binaryInput : extension !== null;
    const transcription = event.session.audio?.input?.transcription;
    if (transcription === null) settings = undefined;
    else if (transcription) {
      const modelId = transcription.model ?? this.settings?.runtime.config.id;
      if (!modelId) throw invalid("missing_model", "A transcription model is required.", "session.audio.input.transcription.model");
      const runtime = this.registry.resolve(modelId, "transcription", this.client);
      const model = runtime.config as TranscriptionModelConfig;
      const language = transcription.language ?? this.settings?.language;
      const prompt = transcription.prompt === "" ? undefined : transcription.prompt ?? this.settings?.prompt;
      if (prompt !== undefined && !model.supports_prompt) throw invalid("unsupported_prompt", "This transcription model does not support prompts.", "session.audio.input.transcription.prompt");
      if (language && model.languages.length && !model.languages.includes(language)) throw invalid("unsupported_language", "This transcription model does not support the requested language.", "session.audio.input.transcription.language");
      settings = { runtime, ...(language ? { language } : {}), ...(prompt !== undefined ? { prompt } : {}) };
    }
    if (format.type === "audio/ogg" && !binaryInput) throw invalid("unsupported_audio_format", "Ogg Opus requires binary_audio_input version 1.", "session.audio.input.format");
    if (format.type === "audio/ogg" && settings && !(settings.runtime.config as TranscriptionModelConfig).input_formats.includes("ogg")) throw invalid("unsupported_audio_format", "This transcription model does not accept Ogg audio.", "session.audio.input.format");
    this.settings = settings; this.format = format; this.binaryInput = binaryInput;
    this.send({ type: "session.updated", session: this.description() });
  }

  private append(audio: string) {
    if (this.binaryInput) throw invalid("invalid_event", "Negotiated binary audio must be sent in WebSocket binary messages.");
    if (!this.settings) throw invalid("session_not_configured", "Configure a transcription model before appending audio.");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)) throw invalid("invalid_audio", "Audio must be canonical base64 PCM16.", "audio");
    const chunk = Buffer.from(audio, "base64");
    if (!chunk.length || chunk.length % 2 || chunk.toString("base64") !== audio) throw invalid("invalid_audio", "Audio must contain whole PCM16 samples encoded as canonical base64.", "audio");
    this.appendChunk(chunk);
  }

  private appendChunk(chunk: Buffer) {
    if (!this.settings) throw invalid("session_not_configured", "Configure a transcription model before appending audio.");
    if (!chunk.length || (this.format.type === "audio/pcm" && chunk.length % 2)) throw invalid("invalid_audio", "Audio must contain nonempty whole PCM16 samples or complete negotiated Ogg pages.", "audio");
    const model = this.settings.runtime.config as TranscriptionModelConfig;
    const maximum = effectiveRealtimeBufferBytes(this.config.server.realtime, model);
    if (this.bytes + chunk.length > maximum) throw invalid("audio_buffer_overflow", "Audio exceeds the session or model buffer limit.", "audio");
    if (this.format.type === "audio/ogg") {
      const ogg = this.ogg ?? new OggOpusValidator(maximum);
      ogg.append(chunk); this.ogg = ogg;
    }
    this.buffer ??= Buffer.alloc(maximum);
    chunk.copy(this.buffer, this.bytes); this.bytes += chunk.length;
  }

  private commit() {
    if (!this.settings) throw invalid("session_not_configured", "Configure a transcription model before committing audio.");
    if (this.job) throw invalid("transcription_busy", "Wait for the previous transcription before committing again.");
    if (!this.buffer) throw invalid("input_audio_buffer_commit_empty", "At least 100 ms of audio is required before committing.");
    const samples = this.format.type === "audio/ogg" ? this.ogg!.finish() : this.bytes;
    if (samples < 4800) throw invalid("input_audio_buffer_commit_empty", "At least 100 ms of audio is required before committing.");
    // Recheck authorization on every commit, not only when selecting the model.
    this.registry.resolve(this.settings.runtime.config.id, "transcription", this.client);
    const audio = this.buffer.subarray(0, this.bytes); const settings = this.settings; const format = this.format;
    this.clearBuffer();
    const itemId = id("item"); const previous = this.previousItemId; this.previousItemId = itemId;
    this.send({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: previous });
    this.job = this.transcribe(audio, samples, format, settings, itemId).then((event) => {
      // A terminal public event also means the worker, files, and queue slot have settled.
      this.job = undefined; this.send(event);
    }).catch((error) => { this.logFailure(publicError(error), "cleanup", itemId); this.close(1011, "Transcription cleanup failed"); }).finally(() => { this.job = undefined; this.resetIdle(); this.finish(); });
    this.resetIdle();
  }

  private clearBuffer() { this.buffer = undefined; this.bytes = 0; this.ogg = undefined; }

  private async transcribe(audio: Buffer, samples: number, format: InputFormat, settings: Settings, itemId: string) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ApiError(504, "server_error", "request_timeout", "Transcription timed out.")), this.config.server.request_timeout_seconds * 1000);
    timer.unref();
    const signal = AbortSignal.any([this.abort.signal, timeout.signal]);
    let upload: StoredUpload | undefined; let releaseModel: (() => void) | undefined;
    let phase = "queue";
    try {
      // Admission precedes media processing so queued requests cannot spawn unbounded ffmpeg jobs.
      releaseModel = await settings.runtime.queue.acquire(signal);
      phase = "staging";
      upload = await (format.type === "audio/ogg" ? storeRealtimeOgg : storeRealtimePcm)(audio, this.config.server.temp_directory, signal);
      phase = "normalization";
      // Duration uses 48 kHz units for both input formats; allow bounded RIFF overhead.
      const maxOutputBytes = Math.ceil(samples / 3) * 2 + 4096;
      const normalized = await normalizeUpload(upload, { ffmpeg: this.config.server.ffmpeg, prlimit: this.config.server.prlimit, memoryBytes: this.config.server.ffmpeg_memory_bytes, timeoutMs: this.config.server.normalization_timeout_seconds * 1000, maxOutputBytes }, signal);
      // Check actual decoded samples, not a client-declared granule or container byte size.
      if (format.type === "audio/ogg" && Math.abs(normalized.durationSeconds * 16000 - samples / 3) > 2) throw invalid("invalid_audio", "Decoded Opus duration does not match the stream's granules.", "audio");
      phase = "inference";
      const result = await this.registry.transcribe(settings.runtime, this.client, { path: normalized.path, ...(settings.language ? { language: settings.language } : {}), ...(settings.prompt !== undefined ? { prompt: settings.prompt } : {}) }, signal);
      signal.throwIfAborted();
      return { type: "conversation.item.input_audio_transcription.completed", item_id: itemId, content_index: 0, transcript: result.text, usage: { type: "duration", seconds: samples / REALTIME_BYTES_PER_SECOND } };
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      // Canonical PCM WAV is server-generated; compressed input is client-supplied.
      const api = format.type === "audio/pcm" && phase === "normalization" && !signal.aborted && failure instanceof ApiError && failure.status >= 400 && failure.status < 500
        ? new ApiError(500, "server_error", "normalization_failed", "Audio normalization failed.")
        : publicError(failure);
      this.logFailure(api, phase, itemId, format.type === "audio/ogg" && phase === "normalization" && !signal.aborted);
      return { type: "conversation.item.input_audio_transcription.failed", item_id: itemId, content_index: 0, error: { type: "transcription_error", code: api.code, message: api.message, param: api.param === "file" ? "audio" : api.param ?? null } };
    } finally {
      clearTimeout(timer);
      try { await upload?.cleanup(); } finally { releaseModel?.(); }
    }
  }

  private logFailure(error: ApiError, phase: string, itemId?: string, compressedNormalization = false) {
    if (error.status < 500 && !compressedNormalization) return;
    // Provider errors can embed recognized text: log only control-plane classifications and IDs.
    const fields = { session_id: this.sessionId, ...(itemId ? { item_id: itemId } : {}), phase, code: error.code, status: error.status };
    if (compressedNormalization && error.status < 500) this.log.warn(fields, "Realtime compressed audio normalization failed");
    else if (error.code === "request_timeout" || error.code === "normalization_timeout") this.log.warn(fields, "Realtime transcription deadline exceeded");
    else this.log.error(fields, "Realtime transcription failed");
  }

  private send(event: Record<string, unknown>) {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    const payload = JSON.stringify({ event_id: id("event"), ...event });
    if (this.socket.bufferedAmount + Buffer.byteLength(payload) > this.config.server.realtime.max_output_bytes) { this.close(1009, "Output buffer limit exceeded"); return; }
    this.socket.send(payload, (error) => { if (error) this.close(1011, "Transport failed"); });
  }

  private resetIdle() {
    if (this.idle) clearTimeout(this.idle);
    if (!this.closed && !this.job) { this.idle = setTimeout(() => this.close(1000, "Session idle timeout"), this.config.server.realtime.idle_timeout_seconds * 1000); this.idle.unref(); }
  }
  close(code: number, reason: string) {
    this.stop();
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(code, reason);
    // Bound teardown even when the remote peer stops reading or never acknowledges close.
    const timer = setTimeout(() => this.socket.terminate(), 1000); timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
  }
  private stop() {
    if (this.closed) return;
    this.closed = true; this.clearBuffer();
    if (this.idle) clearTimeout(this.idle); if (this.lifetime) clearTimeout(this.lifetime);
    this.abort.abort(disconnected()); this.finish();
  }
  private finish() { if (this.closed && !this.job && !this.released) { this.released = true; this.release(); this.removed(); } }
  async settled() { await this.job; }
}

function publicError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(500, "server_error", "transcription_failed", "Transcription could not be completed.");
}
