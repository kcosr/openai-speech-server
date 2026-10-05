import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdir, readdir, rm } from "node:fs/promises";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.js";
import { Authenticator } from "../src/auth/auth.js";
import { Registry } from "../src/runtime/registry.js";
import { testConfig, TOKEN } from "./helpers.js";
import type { Config } from "../src/config/schema.js";

const configuration = (transcription: Record<string, unknown> = { model: "parakeet-local" }) => ({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription, noise_reduction: null, turn_detection: null } } } });
const pcm = Buffer.alloc(9600); // 200 ms at 24 kHz, mono s16le
class Peer {
  readonly events: any[] = [];
  constructor(readonly socket: WebSocket) { socket.on("message", (data) => this.events.push(JSON.parse(data.toString()))); socket.on("error", () => undefined); }
  send(event: unknown) { this.socket.send(JSON.stringify(event)); }
  async next(type: string) { await expect.poll(() => this.events.some((event) => event.type === type), { timeout: 4000 }).toBe(true); const index = this.events.findIndex((event) => event.type === type); return this.events.splice(index, 1)[0]; }
  append(audio = pcm) { this.send({ type: "input_audio_buffer.append", audio: audio.toString("base64") }); }
}

describe("Realtime transcription over real WebSockets", () => {
  let app: FastifyInstance | undefined; const peers: Peer[] = [];
  afterEach(async () => { for (const peer of peers.splice(0)) peer.socket.terminate(); await app?.close(); app = undefined; vi.restoreAllMocks(); });
  async function boot(overrides = {}, concurrency = 2, configure?: (config: Config) => void, diagnostics?: unknown[]) {
    const config = await testConfig(overrides, concurrency); configure?.(config); const registry = new Registry(config); await registry.start();
    app = await buildApp(config, await Authenticator.create(config), registry); app.log.level = "silent";
    if (diagnostics) app.addHook("onRequest", async (request) => { vi.spyOn(request.log, "error").mockImplementation((fields, message) => { diagnostics.push({ request_id: request.id, fields, message }); }); });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    async function connect(query = "intent=transcription", token = TOKEN) {
      const peer = new Peer(new WebSocket(`${url.replace("http:", "ws:")}/v1/realtime?${query}`, { headers: { Authorization: `Bearer ${token}` } })); peers.push(peer);
      await once(peer.socket, "open"); return peer;
    }
    return { config, registry, url, connect };
  }

  it("authenticates and validates mode before upgrading", async () => {
    const { connect, url } = await boot();
    await expect(connect("intent=transcription", "wrong")).rejects.toThrow("401");
    await expect(connect("intent=conversation")).rejects.toThrow("400");
    const http = await fetch(`${url}/v1/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${TOKEN}` } }); expect(http.status).toBe(426);
    expect(http.headers.get("upgrade")).toBe("websocket"); expect(http.headers.get("connection")?.toLowerCase()).toBe("upgrade");
  });
  it("advertises effective GA settings and rejects beta/unsupported updates atomically", async () => {
    const { connect } = await boot(); const peer = await connect();
    expect(await peer.next("session.created")).toMatchObject({ event_id: expect.any(String), session: { type: "transcription", object: "realtime.transcription_session", audio: { input: { transcription: null, format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, noise_reduction: null } } } });
    peer.send({ ...configuration(), event_id: "client-update" });
    const updated = await peer.next("session.updated"); expect(updated.event_id).not.toBe("client-update"); expect(updated.session.audio.input.transcription.model).toBe("parakeet-local");
    peer.send({ type: "transcription_session.update", event_id: "bad-update", session: {} });
    expect(await peer.next("error")).toMatchObject({ error: { code: "invalid_event", event_id: "bad-update" } });
    peer.send({ type: "session.update", session: { type: "transcription", audio: { input: { turn_detection: { type: "server_vad" } } } } });
    expect((await peer.next("error")).error.code).toBe("invalid_event");
    peer.send(configuration({ model: "kokoro-local" })); expect((await peer.next("error")).error.code).toBe("model_not_found");
    peer.send(configuration({ model: "parakeet-local", prompt: "unsupported" })); expect((await peer.next("error")).error.code).toBe("unsupported_prompt");
    peer.send({ type: "session.update", session: { type: "transcription" } }); expect((await peer.next("session.updated")).session.audio.input.transcription.model).toBe("parakeet-local");
  });
  it("normalizes committed PCM, emits final-only correlated transcripts and cleans temporary audio", async () => {
    const { config, connect, registry } = await boot(); const peer = await connect(); peer.send(configuration()); await peer.next("session.updated");
    peer.append(); peer.send({ type: "input_audio_buffer.commit" });
    const committed = await peer.next("input_audio_buffer.committed"); expect(committed.previous_item_id).toBeNull();
    expect(await peer.next("conversation.item.input_audio_transcription.completed")).toMatchObject({ item_id: committed.item_id, content_index: 0, transcript: "test transcript", usage: { type: "duration", seconds: 0.2 } });
    await expect.poll(async () => (await readdir(config.server.temp_directory)).filter((path) => path.endsWith(".wav"))).toEqual([]);
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); expect((await peer.next("input_audio_buffer.committed")).previous_item_id).toBe(committed.item_id);
    await peer.next("conversation.item.input_audio_transcription.completed");
    expect(peer.events.some((event) => event.type.endsWith(".delta"))).toBe(false);
    expect(registry.models.get("parakeet-local")!.provider.restartCount).toBe(0);
  });
  it("clears transcription hints with documented GA settings before switching models", async () => {
    const { connect } = await boot({}, 2, (config) => {
      const model = config.models.find((entry) => entry.task === "transcription")!;
      model.supports_prompt = true; model.languages = ["en"];
      config.models.push({ ...structuredClone(model), id: "other-local", default: false, supports_prompt: false, languages: ["fr"] });
      config.clients[0]!.allowed_models.push("other-local");
    });
    const peer = await connect(); peer.send(configuration({ model: "parakeet-local", language: "en", prompt: "Vocabulary" })); await peer.next("session.updated");
    peer.send(configuration({ model: "other-local" })); expect((await peer.next("error")).error.code).toBe("unsupported_prompt");
    peer.send(configuration({ prompt: "" })); expect((await peer.next("session.updated")).session.audio.input.transcription).toEqual({ model: "parakeet-local", language: "en" });
    peer.send(configuration({ model: "other-local" })); expect((await peer.next("error")).error.code).toBe("unsupported_language");
    peer.send({ type: "session.update", session: { type: "transcription", audio: { input: { transcription: null } } } });
    expect((await peer.next("session.updated")).session.audio.input.transcription).toBeNull();
    peer.append(); expect((await peer.next("error")).error.code).toBe("session_not_configured");
    peer.send(configuration({ model: "other-local" })); expect((await peer.next("session.updated")).session.audio.input.transcription).toEqual({ model: "other-local" });
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); await peer.next("conversation.item.input_audio_transcription.completed");
  });
  it("keeps Realtime normalization independent of the HTTP upload cap", async () => {
    const { connect } = await boot({ max_upload_bytes: 128 }); const peer = await connect(); peer.send(configuration()); await peer.next("session.updated");
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); await peer.next("conversation.item.input_audio_transcription.completed");
  });
  it("classifies and logs failed Realtime normalization as a server fault", async () => {
    const diagnostics: any[] = []; const { connect } = await boot({ ffmpeg: "/usr/bin/false" }, 2, undefined, diagnostics); const peer = await connect(); const created = await peer.next("session.created"); peer.send(configuration()); await peer.next("session.updated");
    peer.append(); peer.send({ type: "input_audio_buffer.commit" });
    const committed = await peer.next("input_audio_buffer.committed");
    expect(await peer.next("conversation.item.input_audio_transcription.failed")).toMatchObject({ error: { code: "normalization_failed", param: null } });
    expect(diagnostics).toContainEqual({ request_id: expect.stringMatching(/^req_/), fields: { session_id: created.session.id, item_id: committed.item_id, phase: "normalization", code: "normalization_failed", status: 500 }, message: "Realtime transcription failed" });
  });
  it("logs safe request/session/item diagnostics for unexpected inference and cleanup failures", async () => {
    const diagnostics: any[] = []; const { connect, registry, config } = await boot({}, 2, undefined, diagnostics);
    const runtime = registry.models.get("parakeet-local")!; const provider = registry.transcription(runtime);
    const peer = await connect(); const created = await peer.next("session.created"); peer.send(configuration()); await peer.next("session.updated");
    const sensitive = `private transcript ${TOKEN} ${pcm.toString("base64")}`;
    vi.spyOn(provider, "transcribe").mockRejectedValueOnce(new Error(sensitive));
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); const first = await peer.next("input_audio_buffer.committed"); await peer.next("conversation.item.input_audio_transcription.failed");
    expect(diagnostics).toContainEqual({ request_id: expect.stringMatching(/^req_/), fields: { session_id: created.session.id, item_id: first.item_id, phase: "inference", code: "transcription_failed", status: 500 }, message: "Realtime transcription failed" });
    vi.spyOn(provider, "transcribe").mockImplementationOnce(async ({ path }) => { await rm(path); await mkdir(path); return { text: sensitive }; });
    const closed = once(peer.socket, "close"); peer.append(); peer.send({ type: "input_audio_buffer.commit" }); const second = await peer.next("input_audio_buffer.committed");
    expect((await closed)[0]).toBe(1011);
    expect(diagnostics).toContainEqual({ request_id: expect.stringMatching(/^req_/), fields: { session_id: created.session.id, item_id: second.item_id, phase: "cleanup", code: "transcription_failed", status: 500 }, message: "Realtime transcription failed" });
    expect(JSON.stringify(diagnostics)).not.toContain(sensitive); expect(JSON.stringify(diagnostics)).not.toContain(TOKEN); expect(JSON.stringify(diagnostics)).not.toContain(pcm.toString("base64"));
    expect(runtime.queue.occupancy).toBe(0); await rm(config.server.temp_directory, { recursive: true, force: true });
  });
  it("clears uncommitted audio and rejects malformed/odd/short input without invoking inference", async () => {
    const { connect, registry } = await boot(); const peer = await connect(); peer.send(configuration()); await peer.next("session.updated");
    for (const audio of ["not base64!", Buffer.alloc(3).toString("base64")]) { peer.send({ type: "input_audio_buffer.append", audio }); expect((await peer.next("error")).error.code).toBe("invalid_audio"); }
    peer.append(); peer.send({ type: "input_audio_buffer.clear" }); await peer.next("input_audio_buffer.cleared");
    peer.send({ type: "input_audio_buffer.commit", event_id: "empty" }); expect(await peer.next("error")).toMatchObject({ error: { code: "input_audio_buffer_commit_empty", event_id: "empty" } });
    expect(registry.models.get("parakeet-local")!.provider.inFlight).toBe(0);
  });
  it("bounds buffered PCM and WebSocket message size", async () => {
    const { connect } = await boot({ realtime: { max_buffer_bytes: 4800, max_message_bytes: 16000 } }); const peer = await connect(); peer.send(configuration()); await peer.next("session.updated");
    const closed = once(peer.socket, "close"); peer.append(); expect((await peer.next("error")).error.code).toBe("audio_buffer_overflow"); expect((await closed)[0]).toBe(1009);
    const second = await connect(); const oversized = once(second.socket, "close"); second.socket.send("x".repeat(16001)); expect((await oversized)[0]).toBe(1009);
  });
  it.each(["server", "model"])("enforces the advertised whole-sample %s buffer limit", async (limit) => {
    const { connect, url } = await boot({ realtime: { max_buffer_bytes: limit === "server" ? 9601 : 48_000 } }, 2, (config) => {
      if (limit === "model") config.models.find((entry) => entry.task === "transcription")!.max_duration_seconds = 9601 / 48_000;
    });
    const response = await fetch(`${url}/v1/audio/capabilities`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { data: Array<{ id: string; realtime: { max_buffer_bytes: number } }> };
    const maximum = catalog.data.find((entry) => entry.id === "parakeet-local")!.realtime.max_buffer_bytes;
    expect(maximum).toBe(9600);
    const peer = await connect(); peer.send(configuration()); await peer.next("session.updated");
    peer.append(Buffer.alloc(maximum)); peer.send({ type: "input_audio_buffer.commit" });
    expect(await peer.next("conversation.item.input_audio_transcription.completed")).toMatchObject({ usage: { seconds: 0.2 } });
    const closed = once(peer.socket, "close");
    peer.append(Buffer.alloc(maximum)); peer.append(Buffer.alloc(2));
    expect((await peer.next("error")).error.code).toBe("audio_buffer_overflow");
    expect((await closed)[0]).toBe(1009);
  });
  it("shares admission with HTTP and releases it after a session closes", async () => {
    const { connect, url } = await boot({}, 1); const peer = await connect();
    await expect(connect()).rejects.toThrow("429");
    const response = await fetch(`${url}/v1/audio/speech`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "default", input: "hello" }) }); expect(response.status).toBe(429);
    peer.socket.close(); await once(peer.socket, "close");
    const second = await connect(); await second.next("session.created");
  });
  it("rejects overlapping commits without losing the next buffer", async () => {
    const { connect } = await boot(); const peer = await connect(); peer.send(configuration({ model: "parakeet-local", language: "slow" })); await peer.next("session.updated");
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); await peer.next("input_audio_buffer.committed");
    peer.append(); peer.send({ type: "input_audio_buffer.commit" }); expect((await peer.next("error")).error.code).toBe("transcription_busy");
    await peer.next("conversation.item.input_audio_transcription.completed"); peer.send({ type: "input_audio_buffer.commit" }); await peer.next("conversation.item.input_audio_transcription.completed");
  });
  it("cancels queued and active work on disconnect without leaking model slots or files", async () => {
    const { connect, registry, config } = await boot({}, 2); const runtime = registry.models.get("parakeet-local")!;
    const first = await connect(); first.send(configuration({ model: "parakeet-local", language: "slow" })); await first.next("session.updated"); first.append(); first.send({ type: "input_audio_buffer.commit" });
    await expect.poll(() => runtime.provider.inFlight).toBe(1);
    const second = await connect(); second.send(configuration()); await second.next("session.updated"); second.append(); second.send({ type: "input_audio_buffer.commit" }); await expect.poll(() => runtime.queue.depth).toBe(1);
    second.socket.terminate(); await expect.poll(() => runtime.queue.depth).toBe(0); first.socket.terminate();
    await expect.poll(() => runtime.queue.occupancy).toBe(0); expect(runtime.provider.inFlight).toBe(0); expect(runtime.provider.restartCount).toBe(0);
    await expect.poll(async () => (await readdir(config.server.temp_directory)).filter((path) => path.endsWith(".wav"))).toEqual([]);
  });
  it("reports correlated inference deadlines and makes the worker usable again", async () => {
    const { connect, registry } = await boot({ request_timeout_seconds: 0.05 }); const peer = await connect(); peer.send(configuration({ model: "parakeet-local", language: "slow" })); await peer.next("session.updated"); peer.append(); peer.send({ type: "input_audio_buffer.commit" });
    const item = await peer.next("input_audio_buffer.committed"); expect(await peer.next("conversation.item.input_audio_transcription.failed")).toMatchObject({ item_id: item.item_id, content_index: 0, error: { type: "transcription_error", code: "request_timeout" } });
    await expect.poll(() => registry.models.get("parakeet-local")!.queue.occupancy).toBe(0);
  });
  it("retains admission until an uncancellable worker settles after disconnect", async () => {
    const { connect, registry } = await boot({}, 1); const runtime = registry.models.get("parakeet-local")!;
    const peer = await connect(); peer.send(configuration({ model: "parakeet-local", language: "uncancellable" })); await peer.next("session.updated"); peer.append(); peer.send({ type: "input_audio_buffer.commit" });
    await expect.poll(() => runtime.provider.inFlight).toBe(1); peer.socket.terminate(); await once(peer.socket, "close");
    await expect(connect()).rejects.toThrow("429"); expect(runtime.queue.occupancy).toBe(1);
    await expect.poll(() => runtime.queue.occupancy).toBe(0); expect(runtime.provider.restartCount).toBe(0);
    const next = await connect(); await next.next("session.created");
  });
  it("correlates provider failures and recovers the pool after worker process death", async () => {
    const { connect, registry } = await boot(); const peer = await connect(); const runtime = registry.models.get("parakeet-local")!;
    for (const language of ["fail", "crash"]) {
      peer.send(configuration({ model: "parakeet-local", language })); await peer.next("session.updated"); peer.append(); peer.send({ type: "input_audio_buffer.commit" });
      const committed = await peer.next("input_audio_buffer.committed");
      expect(await peer.next("conversation.item.input_audio_transcription.failed")).toMatchObject({ item_id: committed.item_id, error: { code: "transcription_failed" } });
      expect(runtime.queue.occupancy).toBe(0); expect(runtime.provider.inFlight).toBe(0);
      await expect.poll(() => runtime.provider.ready, { timeout: 3000 }).toBe(true);
    }
    expect(runtime.provider.restartCount).toBeGreaterThan(0);
    peer.send(configuration({ model: "parakeet-local", language: "en" })); await peer.next("session.updated"); peer.append(); peer.send({ type: "input_audio_buffer.commit" }); await peer.next("conversation.item.input_audio_transcription.completed");
  });
  it("closes idle sessions and terminates active sessions during shutdown", async () => {
    const { connect } = await boot({ realtime: { idle_timeout_seconds: 0.1 } }); const peer = await connect(); const closed = once(peer.socket, "close"); expect((await closed)[0]).toBe(1000);
    const second = await connect(); const secondClosed = once(second.socket, "close"); await app!.close(); app = undefined; expect((await secondClosed)[0]).toBe(1001);
  });
});
