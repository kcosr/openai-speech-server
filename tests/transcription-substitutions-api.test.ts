import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.js";
import { Authenticator, hashToken } from "../src/auth/auth.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import { Registry } from "../src/runtime/registry.js";
import { multipart, testConfig, wav } from "./helpers.js";

const rawTranscript = "Seedus and SEEDES.";
const tokens = { inherited: "substitutions-inherited", another: "substitutions-another", disabled: "substitutions-disabled", alternate: "substitutions-alternate" };
const selections = [
  { client: "inherited", expected: "Sedes & Sedes." },
  { client: "disabled", expected: rawTranscript },
  { client: "alternate", expected: "Sedes Mobile and Sedes Mobile." },
  { client: "another", expected: "Sedes & Sedes." },
] as const;
const pcm = Buffer.alloc(9600);
const configuration = { type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "default" }, noise_reduction: null, turn_detection: null } } } };

class Peer {
  readonly events: any[] = [];
  constructor(readonly socket: WebSocket) { socket.on("message", (data) => this.events.push(JSON.parse(data.toString()))); socket.on("error", () => undefined); }
  send(event: unknown) { this.socket.send(JSON.stringify(event)); }
  async next(type: string) {
    await expect.poll(() => this.events.some((event) => event.type === type), { timeout: 4000 }).toBe(true);
    return this.events.splice(this.events.findIndex((event) => event.type === type), 1)[0];
  }
  commit() { this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }); this.send({ type: "input_audio_buffer.commit" }); }
}

describe("transcription substitutions at HTTP and Realtime boundaries", () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.terminate();
    await app?.close(); app = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined;
    vi.restoreAllMocks();
  });

  async function boot(transcripts: string[], configure?: (config: Config) => void) {
    const base = await testConfig(); directory = base.server.temp_directory;
    const config = ConfigSchema.parse({
      ...base,
      transcription_substitutions: {
        default_rule_set: "shared",
        rule_sets: {
          shared: [
            { id: "product-name", pattern: "\\b(?:seedus|seedes)\\b", replacement: "Sedes" },
            { id: "conjunction", pattern: "\\band\\b", replacement: "&" },
          ],
          mobile: [{ id: "product-name", pattern: "\\b(?:seedus|seedes)\\b", replacement: "Sedes Mobile" }],
        },
      },
      clients: [
        { ...base.clients[0], id: "inherited", token_ref: "inherited" },
        { ...base.clients[0], id: "another", token_ref: "another" },
        { ...base.clients[0], id: "disabled", token_ref: "disabled", transcription_rule_set: null },
        { ...base.clients[0], id: "alternate", token_ref: "alternate", transcription_rule_set: "mobile" },
      ],
    });
    for (const model of config.models) model.provider_config.options.fixture_directory = directory;
    configure?.(config);
    await writeFile(config.auth.tokens_file, JSON.stringify({ tokens: Object.fromEntries(Object.entries(tokens).map(([name, token]) => [name, hashToken(token)])) }));
    await writeFile(join(directory, "fixture-config.json"), JSON.stringify({ transcripts, ttsDurationSeconds: 0.01 }));
    const registry = new Registry(config); await registry.start();
    app = await buildApp(config, await Authenticator.create(config), registry); app.log.level = "silent";
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    async function connect(client: keyof typeof tokens = "inherited") {
      const peer = new Peer(new WebSocket(`${url.replace("http:", "ws:")}/v1/realtime?intent=transcription`, { headers: { authorization: `Bearer ${tokens[client]}` } })); peers.push(peer);
      await once(peer.socket, "open"); await peer.next("session.created");
      peer.send(configuration); await peer.next("session.updated"); return peer;
    }
    return { config, registry, connect };
  }

  function transcribe(client: keyof typeof tokens, fields: Record<string, string> = {}) {
    const form = multipart({ model: "default", ...fields }, wav());
    return app!.inject({ method: "POST", url: "/v1/audio/transcriptions", headers: { authorization: `Bearer ${tokens[client]}`, "content-type": form.contentType }, payload: form.payload });
  }

  async function expectReleased(config: Config, registry: Registry) {
    const runtime = registry.models.get("parakeet-local")!;
    expect(runtime.queue.occupancy).toBe(0); expect(runtime.provider.inFlight).toBe(0);
    expect((await readdir(config.server.temp_directory)).filter((path) => path.endsWith(".wav"))).toEqual([]);
  }

  it("applies inherited, disabled, and alternate rules identically to JSON, text, and final SSE without changing TTS", async () => {
    const { config, registry } = await boot(Array(13).fill(rawTranscript));
    const provider = vi.spyOn(registry.transcription(registry.models.get("parakeet-local")!), "transcribe");
    for (const { client, expected } of selections) {
      const json = await transcribe(client);
      expect(json.statusCode).toBe(200); expect(json.json()).toEqual({ text: expected, language: "en" });
      const text = await transcribe(client, { response_format: "text" });
      expect(text.statusCode).toBe(200); expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8"); expect(text.body).toBe(expected);
      const sse = await transcribe(client, { stream: "true" });
      expect(sse.statusCode).toBe(200); expect(sse.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(sse.body).toBe(`data: ${JSON.stringify({ type: "transcript.text.done", text: expected })}\n\ndata: [DONE]\n\n`);
    }
    // A request cannot switch the authenticated client's configured rule set.
    expect((await transcribe("inherited", { transcription_rule_set: "mobile" })).json().text).toBe("Sedes & Sedes.");
    for (const [request] of provider.mock.calls) expect(Object.keys(request)).toEqual(["path"]);
    const speech = await app!.inject({ method: "POST", url: "/v1/audio/speech", headers: { authorization: `Bearer ${tokens.inherited}`, "content-type": "application/json" }, payload: { model: "default", input: rawTranscript } });
    expect(speech.statusCode).toBe(200); expect(speech.rawPayload.length).toBeGreaterThan(0);
    const observations = (await readFile(join(config.server.temp_directory, "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(observations.filter((event) => event.type === "speech")).toEqual([{ type: "speech", text: rawTranscript }]);
    await expectReleased(config, registry);
  });

  it("applies each client's rules to correlated Realtime completions without leaking selection between sessions", async () => {
    const { config, registry, connect } = await boot(Array(5).fill(rawTranscript));
    let inherited: Peer | undefined;
    for (const { client, expected } of selections) {
      const peer = await connect(client); if (client === "inherited") inherited = peer;
      peer.commit(); const committed = await peer.next("input_audio_buffer.committed");
      expect(await peer.next("conversation.item.input_audio_transcription.completed")).toEqual({
        event_id: expect.any(String), type: "conversation.item.input_audio_transcription.completed", item_id: committed.item_id,
        content_index: 0, transcript: expected, usage: { type: "duration", seconds: 0.2 },
      });
      await expectReleased(config, registry);
    }
    inherited!.commit();
    expect((await inherited!.next("conversation.item.input_audio_transcription.completed")).transcript).toBe("Sedes & Sedes.");
    expect(inherited!.events.some((event) => event.type.endsWith(".delta"))).toBe(false);
  });

  const expansiveTranscript = "boom ".repeat(80).trim();
  function expandingRules(config: Config) {
    config.transcription_substitutions.rule_sets.shared = [{ id: "expansion", pattern: "\\bboom\\b", replacement: "x".repeat(1024), case_insensitive: true }];
    for (const client of config.clients) client.max_concurrent_requests = 1;
  }

  it("returns a bounded standard HTTP error before SSE starts and releases request resources after substitution failure", async () => {
    const { config, registry } = await boot([expansiveTranscript, expansiveTranscript, "fine", expansiveTranscript], expandingRules);
    for (const fields of [{}, { stream: "true" }]) {
      const failed = await transcribe("inherited", fields);
      expect(failed.statusCode).toBe(500); expect(failed.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(failed.json().error).toMatchObject({ type: "server_error", code: "transcription_substitution_output_limit", param: null, request_id: expect.stringMatching(/^req_/) });
      expect(failed.body).not.toContain("boom"); expect(failed.body).not.toContain("xxxx"); expect(failed.body.length).toBeLessThan(1000);
      await expectReleased(config, registry);
    }
    const recovered = await transcribe("inherited"); expect(recovered.statusCode).toBe(200); expect(recovered.json().text).toBe("fine");
    const disabled = await transcribe("disabled"); expect(disabled.statusCode).toBe(200); expect(disabled.json().text).toBe(expansiveTranscript);
  });

  it("correlates Realtime substitution failures and accepts the next utterance and session after cleanup", async () => {
    const { config, registry, connect } = await boot([expansiveTranscript, "fine", "next session"], expandingRules);
    const peer = await connect(); peer.commit(); const committed = await peer.next("input_audio_buffer.committed");
    const failed = await peer.next("conversation.item.input_audio_transcription.failed");
    expect(failed).toMatchObject({ item_id: committed.item_id, content_index: 0, error: { type: "transcription_error", code: "transcription_substitution_output_limit", param: null } });
    expect(JSON.stringify(failed)).not.toContain("boom"); expect(JSON.stringify(failed)).not.toContain("xxxx");
    expect(peer.events.some((event) => event.type.endsWith(".completed"))).toBe(false);
    await expectReleased(config, registry);
    peer.commit(); expect((await peer.next("conversation.item.input_audio_transcription.completed")).transcript).toBe("fine");
    peer.socket.close(); await once(peer.socket, "close");
    const next = await connect(); next.commit(); expect((await next.next("conversation.item.input_audio_transcription.completed")).transcript).toBe("next session");
    await expectReleased(config, registry);
  });
});
