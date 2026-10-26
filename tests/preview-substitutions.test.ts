import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const configuration = {
  server: { listen: "127.0.0.1:1", ffmpeg: "/missing/ffmpeg", prlimit: "/missing/prlimit" },
  auth: { tokens_file: "/missing/tokens.json" },
  models: [{ id: "local", task: "transcription", provider: "parakeet", provider_config: { python: "/missing/python", command: "/missing/worker.py" } }],
  transcription_substitutions: {
    default_rule_set: "common",
    rule_sets: {
      common: [{ id: "app-name", pattern: "\\b(?:seedus|seedes)\\b", replacement: "Sedes" }],
      alternate: [{ id: "other-name", pattern: "\\bseedus\\b", replacement: "Other" }],
    },
  },
  speech_substitutions: {
    default_rule_set: "pronunciation",
    rule_sets: {
      pronunciation: [{ id: "letters", pattern: "\\bMR\\b", replacement: "M. R.", case_insensitive: false }],
      alternate: [{ id: "expanded", pattern: "\\bMR\\b", replacement: "merge request", case_insensitive: false }],
    },
  },
  clients: [
    { id: "inherited", token_ref: "first", allowed_models: ["local"] },
    { id: "disabled", token_ref: "second", allowed_models: ["local"], transcription_rule_set: null, speech_rule_set: null },
    { id: "custom", token_ref: "third", allowed_models: ["local"], transcription_rule_set: "alternate", speech_rule_set: "alternate" },
    { id: "transcription-only-disabled", token_ref: "fourth", allowed_models: ["local"], transcription_rule_set: null },
    { id: "speech-only-disabled", token_ref: "fifth", allowed_models: ["local"], speech_rule_set: null },
  ],
};

describe("offline substitution preview", () => {
  let directory: string;
  let configPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "speech-preview-"));
    configPath = join(directory, "config.yaml");
    await writeFile(configPath, YAML.stringify(configuration));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  function preview(input: string | Buffer, args: string[] = []) {
    return spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/preview-substitutions.ts"), "--config", configPath, ...args], {
      input, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576,
    });
  }

  it("prints one JSON line with corrections and counts without installed model, media, or token files", () => {
    const result = preview("Use SEEDUS and seedes.\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const expected = { text: "Use Sedes and Sedes.\n", ruleSet: "common", matches: [{ ruleId: "app-name", count: 2 }] };
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  });

  it.each([
    ["inherited", "Sedes Sedes", "common", [{ ruleId: "app-name", count: 2 }]],
    ["disabled", "seedus seedes", null, []],
    ["custom", "Other seedes", "alternate", [{ ruleId: "other-name", count: 1 }]],
  ])("resolves client %s using the server selection rules", (client, expected, ruleSet, matches) => {
    const result = preview("seedus seedes", ["--client", client as string]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ text: expected, ruleSet, matches });
  });

  it.each([
    [undefined, "seedus M. R. Mr. MRI", "pronunciation", [{ ruleId: "letters", count: 1 }]],
    ["inherited", "seedus M. R. Mr. MRI", "pronunciation", [{ ruleId: "letters", count: 1 }]],
    ["disabled", "seedus MR Mr. MRI", null, []],
    ["custom", "seedus merge request Mr. MRI", "alternate", [{ ruleId: "expanded", count: 1 }]],
    ["transcription-only-disabled", "seedus M. R. Mr. MRI", "pronunciation", [{ ruleId: "letters", count: 1 }]],
    ["speech-only-disabled", "seedus MR Mr. MRI", null, []],
  ])("previews speech rules independently for client %s without loading a speech model", (client, expected, ruleSet, matches) => {
    const result = preview("seedus MR Mr. MRI", ["--task", "speech", ...(client === undefined ? [] : ["--client", client as string])]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ text: expected, ruleSet, matches });
  });

  it("keeps the default and explicit transcription direction independent of speech rules and selection", () => {
    for (const args of [[], ["--task", "transcription"]]) {
      const result = preview("seedus MR", [...args, "--client", "speech-only-disabled"]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ text: "Sedes MR", ruleSet: "common", matches: [{ ruleId: "app-name", count: 1 }] });
    }
  });

  it("rejects unknown clients without returning sample text", () => {
    const result = preview("private sample", ["--client", "missing"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown configured client ID");
    expect(result.stderr).not.toContain("private sample");
  });

  it("rejects invalid configuration without emitting source contents", async () => {
    await writeFile(configPath, YAML.stringify({ ...configuration, transcription_substitutions: { default_rule_set: "missing" } }));
    const result = preview("private sample");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid configuration at:");
    expect(result.stderr).not.toContain("private sample");
  });

  it("bounds stdin by UTF-8 bytes, including when a client disables substitutions", () => {
    const withinLimit = preview("é".repeat(32_768), ["--client", "disabled"]);
    expect(withinLimit.status, withinLimit.stderr).toBe(0);
    expect(JSON.parse(withinLimit.stdout).text).toBe("é".repeat(32_768));
    const overLimit = preview("é".repeat(32_769), ["--client", "disabled"]);
    expect(overLimit.status).toBe(1);
    expect(overLimit.stdout).toBe("");
    expect(overLimit.stderr).toContain("Input exceeds 65536 UTF-8 bytes");
  });

  it("rejects malformed UTF-8 instead of silently changing the input", () => {
    const result = preview(Buffer.from([0xff]));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Input must be valid UTF-8");
  });

  it("reports correction limits without returning partial or original text", async () => {
    await writeFile(configPath, YAML.stringify({
      ...configuration,
      transcription_substitutions: {
        default_rule_set: "common",
        rule_sets: {
          ...configuration.transcription_substitutions.rule_sets,
          common: [{ id: "expansion", pattern: "seedus", replacement: "X".repeat(1024) }],
        },
      },
    }));
    const result = preview("seedus ".repeat(65) + "private sample");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("transcription_substitution_output_limit");
    expect(result.stderr).not.toContain("private sample");
    expect(result.stderr).not.toContain("seedus");
  });

  it("returns a nonzero status for invalid arguments", () => {
    const result = preview("sample", ["--unknown"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it.each(["synthesis", "", "SPEECH"])("rejects unsupported task %s without emitting sample text", task => {
    const result = preview("private sample", ["--task", task]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--task transcription|speech");
    expect(result.stderr).not.toContain("private sample");
  });

  it("reports speech mapping limits with a speech-specific error and no sample text", async () => {
    await writeFile(configPath, YAML.stringify({
      ...configuration,
      speech_substitutions: {
        default_rule_set: "pronunciation",
        rule_sets: {
          ...configuration.speech_substitutions.rule_sets,
          pronunciation: [{ id: "expansion", pattern: "MR", replacement: "X".repeat(1024) }],
        },
      },
    }));
    const result = preview("MR ".repeat(65) + "private sample", ["--task", "speech"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("speech_substitution_output_limit");
    expect(result.stderr).not.toContain("private sample");
  });

  it.each(["", " \t\n"])("rejects a speech mapping producing only %j without returning sample text", async replacement => {
    await writeFile(configPath, YAML.stringify({
      ...configuration,
      speech_substitutions: {
        ...configuration.speech_substitutions,
        rule_sets: {
          ...configuration.speech_substitutions.rule_sets,
          pronunciation: [{ id: "erase", pattern: "private sample", replacement }],
        },
      },
    }));
    const result = preview("private sample", ["--task", "speech"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("speech_substitution_empty_output");
    expect(result.stderr).not.toContain("private sample");
  });

  it.each([undefined, "disabled"])("preserves unchanged whitespace in speech previews for client %s", client => {
    const result = preview(" \t\n", ["--task", "speech", ...(client === undefined ? [] : ["--client", client])]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ text: " \t\n", ruleSet: client === undefined ? "pronunciation" : null, matches: [] });
  });

  it("continues to allow transcription mappings that delete the entire sample", async () => {
    await writeFile(configPath, YAML.stringify({
      ...configuration,
      transcription_substitutions: {
        ...configuration.transcription_substitutions,
        rule_sets: {
          ...configuration.transcription_substitutions.rule_sets,
          common: [{ id: "erase", pattern: "private sample", replacement: "" }],
        },
      },
    }));
    const result = preview("private sample");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ text: "", ruleSet: "common", matches: [{ ruleId: "erase", count: 1 }] });
  });

  it("bounds expensive matching and closes its worker before exiting", async () => {
    await writeFile(configPath, YAML.stringify({
      ...configuration,
      transcription_substitutions: {
        default_rule_set: "common",
        rule_sets: {
          ...configuration.transcription_substitutions.rule_sets,
          common: Array.from({ length: 10 }, (_, index) => ({ id: `slow-${index}`, pattern: `[^Q]{0,1000}Q${index}`, replacement: "corrected" })),
        },
      },
    }));
    const result = preview("a".repeat(65_536));
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("transcription_substitution_work_limit");
  }, 20_000);
});
