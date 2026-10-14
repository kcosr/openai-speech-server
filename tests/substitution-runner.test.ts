import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.js";
import { AsyncTranscriptSubstitutions, MAX_PENDING_SUBSTITUTIONS, SUBSTITUTION_TIMEOUT_MS } from "../src/transcription/runner.js";

type Rule = Config["transcription_substitutions"]["rule_sets"][string][number];
const rule = (pattern: string, replacement: string, id = "name"): Rule => ({ id, pattern, replacement, case_insensitive: true });
const slowRules = Array.from({ length: 10 }, (_, index) => rule(`[^Q]{0,1000}Q${index}`, "unused", `slow-${index}`));
const slowText = "a".repeat(65_536);
const create = () => new AsyncTranscriptSubstitutions({ default_rule_set: "common", rule_sets: { common: [rule("\\bseedus\\b", "Sedes")], slow: slowRules, empty: [] } });

describe("isolated transcription substitutions", () => {
  it("uses the same corrections, selection semantics, Unicode, and classified errors", async () => {
    const engine = create();
    try {
      await engine.start();
      expect(await engine.apply("😀SEEDUS")).toEqual({ text: "😀Sedes", ruleSet: "common", matches: [{ ruleId: "name", count: 1 }] });
      expect((await engine.apply("seedus", null)).text).toBe("seedus");
      expect((await engine.apply("seedus", "empty")).text).toBe("seedus");
      await expect(engine.apply("\ud800seedus")).rejects.toMatchObject({ code: "transcription_substitution_invalid_unicode" });
      await expect(engine.apply("a".repeat(65_537))).rejects.toMatchObject({ code: "transcription_substitution_input_limit" });
      await expect(engine.apply("seedus", "constructor")).rejects.toMatchObject({ code: "transcription_substitution_configuration" });
      expect((await engine.apply("seedus")).text).toBe("Sedes");
    } finally { await engine.stop(); }
  });

  it("preserves the disabled fast path without starting a worker", async () => {
    const engine = new AsyncTranscriptSubstitutions({ default_rule_set: null, rule_sets: {} });
    try {
      await engine.start();
      const text = "a".repeat(65_537);
      expect(await engine.apply(text)).toEqual({ text, ruleSet: null, matches: [] });
    } finally { await engine.stop(); }
  });

  it("enforces expensive-match deadlines while the main event loop stays responsive, then recovers", async () => {
    const engine = create();
    try {
      await engine.start();
      const started = performance.now();
      const expensive = engine.apply(slowText, "slow").catch(error => error);
      await delay(50);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await expensive).toMatchObject({ status: 500, type: "server_error", code: "transcription_substitution_work_limit" });
      expect(performance.now() - started).toBeLessThan(SUBSTITUTION_TIMEOUT_MS + 1500);
      expect((await engine.apply("seedus")).text).toBe("Sedes");
    } finally { await engine.stop(); }
  }, 10_000);

  it("bounds waiting jobs and cancels queued work without disturbing the active worker", async () => {
    const engine = create();
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    try {
      await engine.start();
      const active = engine.apply(slowText, "slow", activeAbort.signal).catch(error => error);
      const queued = Array.from({ length: MAX_PENDING_SUBSTITUTIONS }, () => engine.apply("seedus", undefined, queuedAbort.signal).catch(error => error));
      await expect(engine.apply("seedus")).rejects.toMatchObject({ status: 503, code: "transcription_substitution_busy" });
      const queuedReason = new Error("queued cancellation");
      queuedAbort.abort(queuedReason);
      expect(await Promise.all(queued)).toEqual(Array(MAX_PENDING_SUBSTITUTIONS).fill(queuedReason));
      const replacement = engine.apply("seedus");
      const activeReason = new Error("active cancellation");
      activeAbort.abort(activeReason);
      expect(await active).toBe(activeReason);
      expect((await replacement).text).toBe("Sedes");
    } finally { await engine.stop(); }
  });

  it("includes queue waiting in each deadline and does not retry timed-out work", async () => {
    const engine = create();
    try {
      await engine.start();
      const active = engine.apply(slowText, "slow").catch(error => error);
      const queued = engine.apply("seedus").catch(error => error);
      expect(await active).toMatchObject({ code: "transcription_substitution_work_limit" });
      expect(await queued).toMatchObject({ code: "transcription_substitution_work_limit" });
      expect((await engine.apply("seedus")).text).toBe("Sedes");
    } finally { await engine.stop(); }
  }, 10_000);

  it("stops active and queued jobs and cannot restart after shutdown", async () => {
    const engine = create();
    await engine.start();
    const active = engine.apply(slowText, "slow").catch(error => error);
    const queued = engine.apply("seedus").catch(error => error);
    await engine.stop();
    expect(await active).toMatchObject({ code: "transcription_substitution_unavailable" });
    expect(await queued).toMatchObject({ code: "transcription_substitution_unavailable" });
    await expect(engine.apply("seedus")).rejects.toMatchObject({ code: "transcription_substitution_unavailable" });
    await expect(engine.start()).rejects.toMatchObject({ code: "transcription_substitution_unavailable" });
    await engine.stop();
  });

  it("honors cancellation before startup without creating work", async () => {
    const engine = create();
    try {
      const reason = new Error("already cancelled");
      await expect(engine.apply("seedus", undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
      expect((await engine.apply("seedus")).text).toBe("Sedes");
    } finally { await engine.stop(); }
  });

  it("settles queued calls on startup failure without exposing pattern diagnostics", async () => {
    // Configuration loading normally rejects this; exercise the worker-failure
    // boundary independently of that earlier validation.
    const engine = new AsyncTranscriptSubstitutions({ default_rule_set: "common", rule_sets: { common: [rule("private-vocabulary(", "replacement")] } });
    try {
      const results = await Promise.all([engine.apply("private transcript").catch(error => error), engine.apply("other transcript").catch(error => error)]);
      for (const error of results) {
        expect(error).toMatchObject({ status: 503, code: "transcription_substitution_unavailable" });
        expect(error.message).not.toMatch(/private|vocabulary|transcript$/);
      }
    } finally { await engine.stop(); }
  });

  it("fits all 3,200 rules near the aggregate program limit in the bounded worker heap", async () => {
    const pattern = "a".repeat(79);
    const engine = new AsyncTranscriptSubstitutions({
      default_rule_set: "set-0",
      rule_sets: Object.fromEntries(Array.from({ length: 32 }, (_, set) => [`set-${set}`, Array.from({ length: 100 }, (_, index) => rule(pattern, `result-${set}`, `rule-${index}`))])),
    });
    try {
      await engine.start();
      for (let set = 0; set < 32; set++) expect((await engine.apply(pattern, `set-${set}`)).text).toBe(`result-${set}`);
      expect((await engine.apply("😀" + pattern)).text).toBe("😀result-0");
    } finally { await engine.stop(); }
  }, 15_000);
});
