import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import type { Config } from "../src/config/schema.js";
import { MAX_SUBSTITUTION_MATCHES, MAX_TRANSCRIPT_BYTES, TranscriptSubstitutions, validateSubstitutionPattern } from "../src/transcription/substitutions.js";

type Rule = Config["transcription_substitutions"]["rule_sets"][string][number];
const rule = (pattern: string, replacement: string, id = "name", caseInsensitive = true): Rule => ({ id, pattern, replacement, case_insensitive: caseInsensitive });
const create = (...rules: Rule[]) => new TranscriptSubstitutions({ default_rule_set: "common", rule_sets: { common: rules } });

function expectFailure(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected substitutions to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, type: "server_error", code: `transcription_substitution_${code}` });
  }
}

describe("transcription substitutions", () => {
  it("maps grouped variations globally with case-insensitive matching by default", () => {
    const result = create(rule("\\b(?:seedes|seedus|sedus)\\b", "Sedes")).apply("SEEDUS, sedus and seedes; xsedus stays.");
    expect(result).toEqual({ text: "Sedes, Sedes and Sedes; xsedus stays.", ruleSet: "common", matches: [{ ruleId: "name", count: 3 }] });
  });

  it("supports case-sensitive rules and leaves unmatched text intact", () => {
    expect(create(rule("seedus", "Sedes", "name", false)).apply("Seedus seedus").text).toBe("Seedus Sedes");
    expect(create(rule("seedus", "Sedes")).apply("already correct")).toEqual({ text: "already correct", ruleSet: "common", matches: [] });
  });

  it("uses literal replacements, including dollars, backslashes, and empty strings", () => {
    const replacement = "$1 $$ $& $` $' $<name> \\1";
    expect(create(rule("(seedus)", replacement)).apply("seedus").text).toBe(replacement);
    expect(create(rule("um ?", "")).apply("um hello um world").text).toBe("hello world");
  });

  it("does not cascade replacement text through other rules", () => {
    expect(create(rule("seedus", "Sedes", "first"), rule("sedes", "changed", "second")).apply("seedus sedes")).toEqual({
      text: "Sedes changed", ruleSet: "common", matches: [{ ruleId: "first", count: 1 }, { ruleId: "second", count: 1 }],
    });
  });

  it("uses the leftmost occurrence and configuration order for ties, not longest match", () => {
    expect(create(rule("bc", "Y", "later"), rule("ab", "X", "earlier")).apply("abc").text).toBe("Xc");
    expect(create(rule("ab", "X", "short"), rule("abc", "Y", "long")).apply("abc").text).toBe("Xc");
    expect(create(rule("abc", "Y", "long"), rule("ab", "X", "short")).apply("abc").text).toBe("Y");
  });

  it("reconsiders an overlapping rule from the next available original position", () => {
    expect(create(rule("ab", "X", "first"), rule("b+c", "Y", "second")).apply("abbc").text).toBe("XY");
    expect(create(rule("abc", "X", "first"), rule("bc", "Y", "second")).apply("abcbc").text).toBe("XY");
  });

  it.each(["^a", "\\ba"])("preserves original anchor context when searching again with %s", pattern => {
    expect(create(rule(pattern, "X", "first"), rule(pattern, "Y", "second")).apply("aa").text).toBe("Xa");
  });

  it("preserves UTF-16 boundaries around repeated astral matches and non-Latin text", () => {
    const engine = create(rule("seedus", "Sedes", "name"), rule("😀", "🦊", "emoji"), rule("猫", "犬", "cjk"));
    expect(engine.apply("😀éseedus 猫😀😀 seedus")).toEqual({ text: "🦊éSedes 犬🦊🦊 Sedes", ruleSet: "common", matches: [{ ruleId: "name", count: 2 }, { ruleId: "emoji", count: 3 }, { ruleId: "cjk", count: 1 }] });
    expect(create(rule("😀+", "ok")).apply("é😀😀x😀").text).toBe("éokxok");
    expect(create(rule("é", "E")).apply("😀é😀é").text).toBe("😀E😀E");
  });

  it("inherits a default, disables with null, and replaces the default for a named override", () => {
    const engine = new TranscriptSubstitutions({ default_rule_set: "common", rule_sets: { common: [rule("seedus", "Sedes")], other: [rule("hello", "Hi")] } });
    expect(engine.apply("hello seedus").text).toBe("hello Sedes");
    expect(engine.apply("hello seedus", null)).toEqual({ text: "hello seedus", ruleSet: null, matches: [] });
    expect(engine.apply("hello seedus", "other")).toEqual({ text: "Hi seedus", ruleSet: "other", matches: [{ ruleId: "name", count: 1 }] });
    expect(engine.apply("hello seedus").text).toBe("hello Sedes");
  });

  it("has no transcript limits or effects when substitutions are disabled or empty", () => {
    const text = "a".repeat(MAX_TRANSCRIPT_BYTES + 1);
    const disabled = new TranscriptSubstitutions({ default_rule_set: null, rule_sets: {} });
    expect(disabled.apply(text)).toEqual({ text, ruleSet: null, matches: [] });
    expect(create().apply(text)).toEqual({ text, ruleSet: "common", matches: [] });
    expect(create(rule("a", "b")).apply(text, null).text).toBe(text);
  });

  it("never resolves inherited object properties as rule sets", () => {
    expectFailure(() => create(rule("a", "b")).apply("a", "constructor"), "configuration");
    const engine = new TranscriptSubstitutions({ default_rule_set: "constructor", rule_sets: { constructor: [rule("a", "b")] } });
    expect(engine.apply("a").text).toBe("b");
  });

  it("bounds active transcript input by UTF-8 bytes", () => {
    const engine = create(rule("absent", "present"));
    const text = "😀".repeat(MAX_TRANSCRIPT_BYTES / 4);
    expect(engine.apply(text).text).toBe(text);
    expectFailure(() => engine.apply(text + "a"), "input_limit");
  });

  it("bounds expanded output by UTF-8 bytes without returning partial text", () => {
    const engine = create(rule("a", "é".repeat(1024)));
    expect(Buffer.byteLength(engine.apply("a".repeat(32)).text)).toBe(MAX_TRANSCRIPT_BYTES);
    expectFailure(() => engine.apply("a".repeat(33)), "output_limit");
    expect(engine.apply("a").text).toBe("é".repeat(1024));
  });

  it("bounds aggregate full-input matching work", () => {
    const engine = create(rule("a", "b"));
    expectFailure(() => engine.apply("a".repeat(MAX_TRANSCRIPT_BYTES)), "work_limit");
    expect(engine.apply("a").text).toBe("b");
  });

  it("bounds candidate count including overlapping rules", () => {
    const engine = create(rule("a", "b", "one"), rule("a", "c", "two"));
    // Two candidates per character reach the match bound before the byte budget.
    expectFailure(() => engine.apply("a".repeat(MAX_SUBSTITUTION_MATCHES / 2 + 1)), "work_limit");
  });

  it("rejects a contextual empty match missed by startup probes and resets for the next call", () => {
    const pattern = "(?:[a\\s!]+)|^\\b";
    expect(validateSubstitutionPattern(pattern, true)).toBeUndefined();
    const engine = create(rule(pattern, "X"));
    expectFailure(() => engine.apply("z"), "empty_match");
    expect(engine.apply("a").text).toBe("X");
  });

  it("uses RE2 for expressions that would cause catastrophic backtracking", () => {
    const text = "a".repeat(32_000) + "!";
    expect(create(rule("(a+)+$", "changed")).apply(text).text).toBe(text);
  });
});
