import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.js";
import { Authenticator, hashToken } from "../src/auth/auth.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import { Registry } from "../src/runtime/registry.js";
import { multipart, testConfig, wav } from "./helpers.js";

const tokens = { inherited: "speech-inherited", disabled: "speech-disabled", alternate: "speech-alternate" };
type ClientName = keyof typeof tokens;
const original = "Review MR 42. Mr. MRI mr; MR!";
const pronounced = "Review M. R. 42. Mr. MRI mr; M. R.!";

describe("configured speech pronunciation substitutions", () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;
  afterEach(async () => {
    await app?.close(); app = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks();
  });

  async function boot(configure?: (config: Config) => void) {
    const base = await testConfig(); directory = base.server.temp_directory;
    const config = ConfigSchema.parse({
      ...base,
      speech_substitutions: {
        default_rule_set: "pronunciation",
        rule_sets: {
          pronunciation: [
            { id: "merge-request", pattern: "\\bMR\\b", replacement: "M. R.", case_insensitive: false },
            { id: "noncascading", pattern: "M\\. R\\.", replacement: "cascaded", case_insensitive: false },
          ],
          expanded: [{ id: "merge-request", pattern: "\\bMR\\b", replacement: "merge request", case_insensitive: false }],
        },
      },
      transcription_substitutions: {
        default_rule_set: "transcription",
        rule_sets: { transcription: [{ id: "transcription-only", pattern: "\\bMR\\b", replacement: "corrected transcript", case_insensitive: false }] },
      },
      clients: [
        { ...base.clients[0], id: "inherited", token_ref: "inherited", max_concurrent_requests: 1 },
        { ...base.clients[0], id: "disabled", token_ref: "disabled", speech_rule_set: null, max_concurrent_requests: 1 },
        { ...base.clients[0], id: "alternate", token_ref: "alternate", speech_rule_set: "expanded", max_concurrent_requests: 1 },
      ],
    });
    for (const model of config.models) model.provider_config.options.fixture_directory = directory;
    configure?.(config);
    await writeFile(config.auth.tokens_file, JSON.stringify({ tokens: Object.fromEntries(Object.entries(tokens).map(([name, token]) => [name, hashToken(token)])) }));
    await writeFile(join(directory, "fixture-config.json"), JSON.stringify({ transcripts: ["MR", "MR"], ttsDurationSeconds: 0.01 }));
    const registry = new Registry(config);
    try {
      await registry.start();
      app = await buildApp(config, await Authenticator.create(config), registry); app.log.level = "silent";
    } catch (error) { await registry.stop(); throw error; }
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    return { config, registry, url };
  }

  function speech(input: string, client: ClientName = "inherited", fields: Record<string, unknown> = {}) {
    return app!.inject({ method: "POST", url: "/v1/audio/speech", headers: { authorization: `Bearer ${tokens[client]}`, "content-type": "application/json" }, payload: { model: "default", input, response_format: "pcm", ...fields } });
  }

  async function observedSpeech(): Promise<Array<{ type: string; text: string }>> {
    const content = await readFile(join(directory!, "observations.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === "speech");
  }

  function expectReleased(registry: Registry) {
    const runtime = registry.models.get("kokoro-local")!;
    expect(runtime.queue.occupancy).toBe(0); expect(runtime.provider.inFlight).toBe(0);
  }

  it("maps only engine-bound text with inherited, disabled, and alternate selections for PCM and WAV", async () => {
    const { registry } = await boot();
    const selections = [
      { client: "inherited", text: pronounced },
      { client: "disabled", text: original },
      { client: "alternate", text: "Review merge request 42. Mr. MRI mr; merge request!" },
    ] as const;
    for (const format of ["pcm", "wav"] as const) {
      for (const { client, text } of selections) {
        const payload = { model: "default", input: original, response_format: format };
        const response = await app!.inject({ method: "POST", url: "/v1/audio/speech", headers: { authorization: `Bearer ${tokens[client]}`, "content-type": "application/json" }, payload });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe(format === "pcm" ? "audio/pcm; rate=24000; channels=1; format=s16le" : "audio/wav");
        expect(response.rawPayload.length).toBeGreaterThan(0);
        if (format === "wav") expect(response.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(payload.input).toBe(original);
        expect((await observedSpeech()).at(-1)).toEqual({ type: "speech", text });
        expectReleased(registry);
      }
    }
    // All matches come from the original text: the inserted M. R. never cascades.
    expect((await observedSpeech()).map((event) => event.text)).toEqual([...selections, ...selections].map(({ text }) => text));
  });

  it("keeps selection in configuration and speech rules independent of transcription rules", async () => {
    await boot();
    for (const speech_rule_set of [null, "expanded"]) {
      expect((await speech("MR", "inherited", { speech_rule_set })).statusCode).toBe(200);
    }
    expect((await observedSpeech()).map((event) => event.text)).toEqual(["M. R.", "M. R."]);
    for (const client of ["inherited", "disabled"] as const) {
      const form = multipart({ model: "default" }, wav());
      const response = await app!.inject({ method: "POST", url: "/v1/audio/transcriptions", headers: { authorization: `Bearer ${tokens[client]}`, "content-type": form.contentType }, payload: form.payload });
      expect(response.statusCode, response.body).toBe(200); expect(response.json().text).toBe("corrected transcript");
    }
  });

  it("preserves unmapped input and configurations with no default speech dictionary", async () => {
    const { registry } = await boot((config) => { config.speech_substitutions.default_rule_set = null; });
    expect((await speech(original)).statusCode).toBe(200);
    expect((await speech("ordinary text", "alternate")).statusCode).toBe(200);
    expect((await observedSpeech()).map((event) => event.text)).toEqual([original, "ordinary text"]);
    expectReleased(registry);
  });

  it("rejects original oversize inputs before contraction and mapped expansions before audio, then recovers", async () => {
    const { registry } = await boot((config) => {
      config.models.find((model) => model.task === "speech")!.max_text_length = 12;
      config.speech_substitutions.rule_sets.pronunciation = [
        { id: "expansion", pattern: "\\bMR\\b", replacement: "merge request", case_insensitive: false },
        { id: "contraction", pattern: "TOO-LONG-INPUT", replacement: "x", case_insensitive: false },
      ];
    });
    const originalLimit = await speech("TOO-LONG-INPUT");
    expect(originalLimit.statusCode).toBe(400); expect(originalLimit.json().error).toMatchObject({ code: "input_too_long", param: "input" });
    const expanded = await speech("MR");
    expect(expanded.statusCode).toBe(500); expect(expanded.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(expanded.json().error).toMatchObject({ type: "server_error", code: "speech_substitution_output_limit", param: null, request_id: expect.stringMatching(/^req_/) });
    expect(expanded.body).not.toContain("merge request"); expect(expanded.body.length).toBeLessThan(1000);
    expect(await observedSpeech()).toEqual([]); expectReleased(registry);
    expect((await speech("ready")).statusCode).toBe(200);
    expect((await speech("MR", "disabled")).statusCode).toBe(200);
    expect((await observedSpeech()).map((event) => event.text)).toEqual(["ready", "MR"]);
    expectReleased(registry);
  });

  it("rejects empty and whitespace-only mapped output before audio while allowing partial deletion", async () => {
    const { registry } = await boot((config) => {
      config.speech_substitutions.rule_sets.pronunciation = [
        { id: "delete", pattern: "remove", replacement: "", case_insensitive: false },
        { id: "silence", pattern: "^quiet$", replacement: "   ", case_insensitive: false },
      ];
    });
    for (const input of ["remove", "quiet"]) {
      const response = await speech(input);
      expect(response.statusCode).toBe(500); expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.json().error).toMatchObject({ type: "server_error", code: "speech_substitution_empty_output", param: null });
      expect(await observedSpeech()).toEqual([]); expectReleased(registry);
    }
    expect((await speech("remove this")).statusCode).toBe(200);
    expect((await speech("quiet", "disabled")).statusCode).toBe(200);
    expect((await observedSpeech()).map((event) => event.text)).toEqual([" this", "quiet"]);
    expectReleased(registry);
  });

  it("reports the active mapping UTF-8 input cap as a client error and preserves disabled input", async () => {
    const { registry } = await boot((config) => {
      config.models.find((model) => model.task === "speech")!.max_text_length = 30_000;
    });
    const input = "界".repeat(21_846);
    const response = await speech(input);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ type: "invalid_request_error", code: "input_too_long", param: "input" });
    expect(response.json().error.message).toContain("65536");
    expect(await observedSpeech()).toEqual([]); expectReleased(registry);
    expect((await speech(input, "disabled")).statusCode).toBe(200);
    expect((await speech("MR")).statusCode).toBe(200);
    expect((await observedSpeech()).map((event) => event.text)).toEqual([input, "M. R."]);
    expectReleased(registry);
  });

  it("reports malformed Unicode in JSON input as a client error without changing disabled passthrough", async () => {
    const { registry } = await boot();
    const input = "private-sentinel-\ud800-sensitive";
    const response = await app!.inject({ method: "POST", url: "/v1/audio/speech", headers: { authorization: `Bearer ${tokens.inherited}`, "content-type": "application/json" }, payload: JSON.stringify({ model: "default", input }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ type: "invalid_request_error", code: "invalid_input", param: "input", message: "Input contains malformed Unicode." });
    expect(response.body).not.toContain("private-sentinel"); expect(response.body).not.toContain("\\ud800");
    expect(await observedSpeech()).toEqual([]); expectReleased(registry);
    expect((await speech(input, "disabled")).statusCode).toBe(200);
    expect((await speech("MR")).statusCode).toBe(200);
    expect((await observedSpeech()).map((event) => event.text)).toEqual([input, "M. R."]);
    expectReleased(registry);
  });

  function expensiveRules(config: Config) {
    config.models.find((model) => model.task === "speech")!.max_text_length = 65_536;
    config.speech_substitutions.rule_sets.pronunciation = [
      ...Array.from({ length: 10 }, (_, index) => ({ id: `slow-${index}`, pattern: `[^Q]{0,1000}Q${index}`, replacement: "unused", case_insensitive: true })),
      { id: "merge-request", pattern: "\\bMR\\b", replacement: "M. R.", case_insensitive: false },
    ];
  }

  it("includes mapping in the first-byte deadline, stays responsive, and recovers without invoking synthesis", async () => {
    const { registry } = await boot((config) => { expensiveRules(config); config.server.request_timeout_seconds = 1; });
    const pending = speech("a".repeat(65_536));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await app!.inject({ url: "/health/live" })).statusCode).toBe(200);
    const response = await pending;
    expect(response.statusCode).toBe(504); expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.json().error.code).toBe("first_byte_timeout");
    expect(await observedSpeech()).toEqual([]); expectReleased(registry);
    expect((await speech("MR")).statusCode).toBe(200);
    expect(await observedSpeech()).toEqual([{ type: "speech", text: "M. R." }]); expectReleased(registry);
  }, 10_000);

  it("releases admission after a client disconnects during mapping and accepts the next request", async () => {
    const { registry, url } = await boot(expensiveRules);
    const controller = new AbortController();
    let mappingStarted!: () => void;
    const started = new Promise<void>((resolve) => { mappingStarted = resolve; });
    const prepare = registry.prepareSpeech.bind(registry);
    vi.spyOn(registry, "prepareSpeech").mockImplementation((...args) => {
      if (args[2].input.length === 65_536) mappingStarted();
      return prepare(...args);
    });
    const pending = fetch(`${url}/v1/audio/speech`, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${tokens.inherited}`, "content-type": "application/json" }, body: JSON.stringify({ model: "default", input: "a".repeat(65_536) }) }).catch((error) => error);
    try {
      await started;
      expect((await speech("probe")).statusCode).toBe(429);
      expect(await observedSpeech()).toEqual([]);
    } finally { controller.abort(); }
    expect(await pending).toMatchObject({ name: "AbortError" });
    await expect.poll(async () => (await speech("MR")).statusCode, { timeout: 3000 }).toBe(200);
    expect(await observedSpeech()).toEqual([{ type: "speech", text: "M. R." }]); expectReleased(registry);
  }, 10_000);
});
