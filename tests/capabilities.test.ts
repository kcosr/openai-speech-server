import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/app.js";
import { Authenticator } from "../src/auth/auth.js";
import { Registry } from "../src/runtime/registry.js";
import { RealtimeCapabilitySchema } from "../src/runtime/realtime-limits.js";
import { testConfig, TOKEN } from "./helpers.js";

describe("authorized Realtime model capabilities", () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;
  const headers = { authorization: `Bearer ${TOKEN}` };
  afterEach(async () => {
    await app?.close(); app = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("requires authentication and publishes every default limit only on transcription models", async () => {
    const config = await testConfig(); directory = config.server.temp_directory;
    app = await buildApp(config, await Authenticator.create(config), new Registry(config));
    expect((await app.inject({ url: "/v1/audio/capabilities" })).statusCode).toBe(401);
    const response = await app.inject({ url: "/v1/audio/capabilities", headers });
    expect(response.statusCode).toBe(200);
    const models = response.json().data;
    const transcription = models.find((model: { task: string }) => model.task === "transcription");
    expect(RealtimeCapabilitySchema.parse(transcription.realtime)).toEqual({
      max_buffer_bytes: 5_760_000,
      max_message_bytes: 1_048_576,
      max_output_bytes: 1_048_576,
      idle_timeout_seconds: 60,
      max_session_seconds: 3600,
    });
    expect(models.find((model: { task: string }) => model.task === "speech")).not.toHaveProperty("realtime");
  });

  it("reports effective per-model whole-sample limits without exposing unavailable models or raising small limits", async () => {
    const settings = { max_buffer_bytes: 48_001, max_message_bytes: 8192, max_output_bytes: 524_288,
      idle_timeout_seconds: 40.25, max_session_seconds: 600.5 };
    const config = await testConfig({ realtime: settings }); directory = config.server.temp_directory;
    const model = config.models.find((entry) => entry.task === "transcription")!;
    config.models.push(
      { ...structuredClone(model), id: "short-local", default: false, max_duration_seconds: 0.50004 },
      { ...structuredClone(model), id: "tiny-local", default: false, max_duration_seconds: 0.00001 },
      { ...structuredClone(model), id: "hidden-local", default: false, max_duration_seconds: 10 },
      { ...structuredClone(model), id: "disabled-local", default: false, enabled: false },
    );
    config.clients[0]!.allowed_models.push("short-local", "tiny-local", "disabled-local");
    app = await buildApp(config, await Authenticator.create(config), new Registry(config));
    const response = await app.inject({ url: "/v1/audio/capabilities", headers });
    expect(response.statusCode).toBe(200);
    const models = response.json().data as Array<{ id: string; task: string; realtime?: unknown }>;
    expect(models.map((entry) => entry.id)).toEqual(["parakeet-local", "kokoro-local", "short-local", "tiny-local"]);
    const expectedBytes = new Map([["parakeet-local", 48_000], ["short-local", 24_000], ["tiny-local", 0]]);
    for (const entry of models.filter((entry) => entry.task === "transcription")) {
      expect(RealtimeCapabilitySchema.parse(entry.realtime)).toEqual({ ...settings, max_buffer_bytes: expectedBytes.get(entry.id) });
    }
    expect(response.body).not.toContain("provider_config");
    expect(response.body).not.toContain("fake_worker.py");
  });
});
