import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const base = { server: { listen: "127.0.0.1:1" }, auth: { tokens_file: "/x" }, models: [{ id: "speech", task: "speech", provider: "kokoro", default_voice: "a", voices: ["a"], output_formats: ["pcm"], provider_config: { python: "python3" } }], clients: [{ id: "client", token_ref: "x", allowed_models: ["speech"] }] };
describe("configuration", () => {
  it.each(["idle_timeout_seconds", "max_session_seconds"] as const)("bounds Realtime %s to enforceable Node timer delays", field => {
    const parse = (seconds: number) => ConfigSchema.parse({ ...base, server: { ...base.server, realtime: { [field]: seconds } } });
    expect(parse(2_147_483).server.realtime[field]).toBe(2_147_483);
    expect(parse(0.25).server.realtime[field]).toBe(0.25);
    expect(() => parse(2_147_484)).toThrow();
    expect(() => parse(2_592_000)).toThrow();
  });
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

describe("transcription substitution configuration", () => {
  const rule = { id: "name", pattern: "\\b(?:seedus|sedus)\\b", replacement: "Sedes" };
  const substitutions = { default_rule_set: "common", rule_sets: { common: [rule] } };
  const parse = (value: unknown = substitutions, clients: unknown = base.clients) => ConfigSchema.parse({ ...base, transcription_substitutions: value, clients });

  it("defaults to disabled and leaves client inheritance distinct from null", () => {
    expect(ConfigSchema.parse(base).transcription_substitutions).toEqual({ default_rule_set: null, rule_sets: {} });
    expect(parse({}).transcription_substitutions).toEqual({ default_rule_set: null, rule_sets: {} });
    const config = parse(substitutions, [{ ...base.clients[0]!, transcription_rule_set: null }]);
    expect(config.clients[0]!.transcription_rule_set).toBeNull();
    expect(parse().clients[0]!.transcription_rule_set).toBeUndefined();
    expect(parse().transcription_substitutions.rule_sets.common?.[0]?.case_insensitive).toBe(true);
  });

  it("accepts a named client override and an empty replacement", () => {
    const config = parse({ ...substitutions, rule_sets: { common: [{ ...rule, replacement: "" }] } }, [{ ...base.clients[0]!, transcription_rule_set: "common" }]);
    expect(config.clients[0]!.transcription_rule_set).toBe("common");
    expect(config.transcription_substitutions.rule_sets.common?.[0]?.replacement).toBe("");
  });

  it.each(["missing", "constructor", "tostring"])("rejects unknown default and client rule sets: %s", name => {
    expect(() => parse({ ...substitutions, default_rule_set: name })).toThrow(/Unknown default/);
    expect(() => parse(substitutions, [{ ...base.clients[0]!, transcription_rule_set: name }])).toThrow(/Unknown client/);
  });

  it("rejects duplicate rule IDs but allows reuse across sets", () => {
    expect(() => parse({ ...substitutions, rule_sets: { common: [rule, rule] } })).toThrow(/Duplicate substitution rule/);
    expect(() => parse({ ...substitutions, rule_sets: { common: [rule], other: [rule] } })).not.toThrow();
  });

  it.each(["(", "a(?=b)", "(?<=a)b", "(a)\\1", "\\C", String.raw`\c\Q|\C`, String.raw`\u0061`])("rejects invalid or unsupported expressions in unused rule sets: %s", pattern => {
    expect(() => parse({ rule_sets: { unused: [{ ...rule, pattern }] } })).toThrow(/RE2/);
  });

  it("accepts literal backslash-C and RE2 quoted text", () => {
    for (const pattern of [String.raw`\\C`, String.raw`\Q\C\E`]) expect(() => parse({ rule_sets: { common: [{ ...rule, pattern }] } })).not.toThrow();
  });

  it.each(["", "^", "$", "\\b", "\\B", "a*", "(?:seedus)?", "seedus|"])("rejects empty-match expressions at startup: %s", pattern => {
    expect(() => parse({ rule_sets: { common: [{ ...rule, pattern }] } })).toThrow();
  });

  it("bounds rule sets, rules, names, patterns, and replacements", () => {
    expect(() => parse({ rule_sets: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`set-${index}`, []])) })).toThrow(/At most 32/);
    expect(() => parse({ rule_sets: { common: Array.from({ length: 101 }, (_, index) => ({ ...rule, id: `rule-${index}` })) } })).toThrow();
    for (const field of ["pattern", "replacement"] as const) expect(() => parse({ rule_sets: { common: [{ ...rule, [field]: "a".repeat(1025) }] } })).toThrow();
    expect(() => parse({ rule_sets: { ["a".repeat(65)]: [] } })).toThrow();
    expect(() => parse({ rule_sets: { common: [{ ...rule, id: "a".repeat(65) }] } })).toThrow();
  });

  it("rejects malformed Unicode patterns and replacement text", () => {
    for (const field of ["pattern", "replacement"]) {
      expect(() => parse({ rule_sets: { common: [{ ...rule, [field]: "\ud800" }] } })).toThrow(/well-formed Unicode/);
      expect(() => parse({ rule_sets: { common: [{ ...rule, [field]: "\udc00" }] } })).toThrow(/well-formed Unicode/);
    }
  });

  it("bounds compiled programs per expression and across every rule set", () => {
    expect(() => parse({ rule_sets: { common: [{ ...rule, pattern: "(?:abcde){1000}" }] } })).toThrow(/4096-instruction/);
    const maximumProgramRule = { ...rule, pattern: "(?:abcd){1000}q{94}" };
    expect(() => parse({ rule_sets: { common: [maximumProgramRule] } })).not.toThrow();
    const rule_sets = { common: Array.from({ length: 65 }, (_, index) => ({ ...maximumProgramRule, id: `rule-${index}` })) };
    expect(() => parse({ rule_sets })).toThrow(/262144-instruction total/);
  }, 15_000);

  it("rejects alias fields and unknown options", () => {
    expect(() => parse({ default: "common", rule_sets: {} })).toThrow();
    expect(() => parse({ rule_sets: { common: [{ ...rule, flags: "i" }] } })).toThrow();
    expect(() => ConfigSchema.parse({ ...base, clients: [{ ...base.clients[0], substitution_rules: [] }] })).toThrow();
  });
});
