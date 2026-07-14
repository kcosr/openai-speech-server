import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const base = { server: { listen: "127.0.0.1:1" }, auth: { tokens_file: "/x" }, models: [{ id: "speech", task: "speech", provider: "kokoro", default_voice: "a", voices: ["a"], output_formats: ["pcm"], provider_config: { python: "python3" } }], clients: [{ id: "client", token_ref: "x", allowed_models: ["speech"] }] };
describe("configuration", () => {
  it("applies strict defaults", () => { const config = ConfigSchema.parse(base); expect(config.server.queue_max_depth).toBe(8); expect(config.models[0]?.enabled).toBe(true); expect(config.models[0]?.extensions).toEqual({}); expect(config.models[0]?.provider_config.options).toEqual({}); expect(config.models[0]?.provider_config.warmup_timeout_seconds).toBe(120); });
  it("rejects unknown fields", () => expect(() => ConfigSchema.parse({ ...base, legacy: true })).toThrow());
  it("rejects duplicate IDs", () => expect(() => ConfigSchema.parse({ ...base, models: [...base.models, ...base.models] })).toThrow(/Duplicate model/));
  it("rejects unknown client models", () => expect(() => ConfigSchema.parse({ ...base, clients: [{ ...base.clients[0], allowed_models: ["missing"] }] })).toThrow(/Unknown allowed model/));
  it("reserves the default model alias", () => expect(() => ConfigSchema.parse({ ...base, models: [{ ...base.models[0], id: "default" }], clients: [{ ...base.clients[0], allowed_models: ["default"] }] })).toThrow(/reserved/));
  it("rejects multiple defaults for one task", () => expect(() => ConfigSchema.parse({ ...base, models: [{ ...base.models[0], id: "one", default: true }, { ...base.models[0], id: "two", default: true }], clients: [{ ...base.clients[0], allowed_models: ["one", "two"] }] })).toThrow(/Only one default/));
  it("rejects voice allowlists for unknown models", () => expect(() => ConfigSchema.parse({ ...base, clients: [{ ...base.clients[0], allowed_voices: { missing: ["a"] } }] })).toThrow(/not a configured speech model/));
  it("rejects voices absent from the selected model", () => expect(() => ConfigSchema.parse({ ...base, clients: [{ ...base.clients[0], allowed_voices: { speech: ["missing"] } }] })).toThrow(/Unknown voice/));
  it("rejects the obsolete extension allowlist shape", () => expect(() => ConfigSchema.parse({ ...base, models: [{ ...base.models[0], supported_extensions: ["legacy"] }] })).toThrow());
  it("fails fast when an enabled model executable is missing", async () => { const directory = await mkdtemp(join(tmpdir(), "speech-config-")); const path = join(directory, "config.yaml"); try { await writeFile(path, YAML.stringify({ ...base, server: { listen: "127.0.0.1:1", ffmpeg: "/usr/bin/true", prlimit: "/usr/bin/true" }, models: [{ ...base.models[0], provider_config: { python: "/definitely/missing/python" } }] })); await expect(loadConfig(path)).rejects.toThrow(/Python executable.*missing or not executable/); } finally { await rm(directory, { recursive: true, force: true }); } });
  it("fails fast when a custom worker command is missing", async () => { const directory = await mkdtemp(join(tmpdir(), "speech-config-")); const path = join(directory, "config.yaml"); try { await writeFile(path, YAML.stringify({ ...base, server: { listen: "127.0.0.1:1", ffmpeg: "/usr/bin/true", prlimit: "/usr/bin/true" }, models: [{ ...base.models[0], provider: "custom", provider_config: { python: process.execPath, command: "/definitely/missing/worker.py" } }] })); await expect(loadConfig(path)).rejects.toThrow(/Worker command.*missing or not readable/); } finally { await rm(directory, { recursive: true, force: true }); } });
});
