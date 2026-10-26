import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import { MAX_SUBSTITUTION_MATCHES, MAX_TEXT_BYTES, TextSubstitutions, inspectSubstitutionPattern } from "../src/substitutions/substitutions.js";

type Rule = Config["transcription_substitutions"]["rule_sets"][string][number];
const rule = (pattern: string, replacement: string, id = "name", caseInsensitive = true): Rule => ({ id, pattern, replacement, case_insensitive: caseInsensitive });
describe.each(["transcription", "speech"] as const)("%s substitutions", task => {
  const createEngine = (config: Config["transcription_substitutions"]) => new TextSubstitutions(config, task);
  const create = (...rules: Rule[]) => createEngine({ default_rule_set: "common", rule_sets: { common: rules } });
  function expectFailure(operation: () => unknown, code: string): void {
    try {
      operation();
      throw new Error("Expected substitutions to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 500, type: "server_error", code: `${task}_substitution_${code}` });
    }
  }

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
    const engine = createEngine({ default_rule_set: "common", rule_sets: { common: [rule("seedus", "Sedes")], other: [rule("hello", "Hi")] } });
    expect(engine.apply("hello seedus").text).toBe("hello Sedes");
    expect(engine.apply("hello seedus", null)).toEqual({ text: "hello seedus", ruleSet: null, matches: [] });
    expect(engine.apply("hello seedus", "other")).toEqual({ text: "Hi seedus", ruleSet: "other", matches: [{ ruleId: "name", count: 1 }] });
    expect(engine.apply("hello seedus").text).toBe("hello Sedes");
  });

  it("has no text limits or effects when substitutions are disabled or empty", () => {
    const text = "a".repeat(MAX_TEXT_BYTES + 1);
    const disabled = createEngine({ default_rule_set: null, rule_sets: {} });
    expect(disabled.apply(text)).toEqual({ text, ruleSet: null, matches: [] });
    expect(create().apply(text)).toEqual({ text, ruleSet: "common", matches: [] });
    expect(create(rule("a", "b")).apply(text, null).text).toBe(text);
  });

  it("never resolves inherited object properties as rule sets", () => {
    expectFailure(() => create(rule("a", "b")).apply("a", "constructor"), "configuration");
    const engine = createEngine({ default_rule_set: "constructor", rule_sets: { constructor: [rule("a", "b")] } });
    expect(engine.apply("a").text).toBe("b");
  });

  it("bounds active text input by UTF-8 bytes", () => {
    const engine = create(rule("absent", "present"));
    const text = "😀".repeat(MAX_TEXT_BYTES / 4);
    expect(engine.apply(text).text).toBe(text);
    expectFailure(() => engine.apply(text + "a"), "input_limit");
  });

  it("bounds expanded output by UTF-8 bytes without returning partial text", () => {
    const engine = create(rule("a", "é".repeat(1024)));
    expect(Buffer.byteLength(engine.apply("a".repeat(32)).text)).toBe(MAX_TEXT_BYTES);
    expectFailure(() => engine.apply("a".repeat(33)), "output_limit");
    expect(engine.apply("a").text).toBe("é".repeat(1024));
  });

  it("bounds dense candidate counts and remains usable afterward", () => {
    const engine = create(rule("a", "b"));
    expectFailure(() => engine.apply("a".repeat(MAX_TEXT_BYTES)), "work_limit");
    expect(engine.apply("a").text).toBe("b");
    expect(engine.apply("a".repeat(MAX_SUBSTITUTION_MATCHES)).text).toBe("b".repeat(MAX_SUBSTITUTION_MATCHES));
  });

  it("bounds candidate count including overlapping rules", () => {
    const engine = create(rule("a", "b", "one"), rule("a", "c", "two"));
    // Discarded overlap candidates still count toward the processing limit.
    expectFailure(() => engine.apply("a".repeat(MAX_SUBSTITUTION_MATCHES / 2 + 1)), "work_limit");
  });

  it("rejects a contextual empty match missed by startup probes and resets for the next call", () => {
    const pattern = "(?:[a\\s!]+)|^\\b";
    expect(inspectSubstitutionPattern(pattern, true).error).toBeUndefined();
    const engine = create(rule(pattern, "X"));
    expectFailure(() => engine.apply("z"), "empty_match");
    expect(engine.apply("a").text).toBe("X");
  });

  it("uses RE2 for expressions that would cause catastrophic backtracking", () => {
    const text = "a".repeat(32_000) + "!";
    expect(create(rule("(a+)+$", "changed")).apply(text).text).toBe(text);
  });

  it("uses native RE2 quoting without rewriting literal slashes", () => {
    expect(create(rule(String.raw`\Qand/or\E`, "either")).apply("and/or then and/or").text).toBe("either then either");
    expect(create(rule(String.raw`\Q\C\E`, "literal")).apply(String.raw`use \C`).text).toBe("use literal");
  });

  it.each(["\ud800seedus", "seedus\udc00", "\ud800\ud800", "\udc00\ud800"])("fails explicitly for malformed text Unicode", text => {
    const engine = create(rule("seedus", "Sedes"));
    expectFailure(() => engine.apply(text), "invalid_unicode");
    expect(engine.apply("😀seedus").text).toBe("😀Sedes");
    expect(engine.apply(text, null).text).toBe(text);
  });

  it.each([String.raw`\x{D83D}`, String.raw`\x{DE00}`])("rejects escaped surrogate matches that split a valid Unicode character: %s", pattern => {
    expectFailure(() => create(rule(pattern, "broken")).apply("😀seedus"), "invalid_match");
  });

  it("corrects dense 64-KiB text with 100 rules without a whole-input copy budget", () => {
    const rules = [rule("\\bseedus\\b", "Sedes"), ...Array.from({ length: 99 }, (_, index) => rule(`unused-${index}`, "other", `unused-${index}`))];
    const text = "seedus complete ".repeat(4096);
    expect(Buffer.byteLength(text)).toBe(MAX_TEXT_BYTES);
    const engine = create(...rules);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = engine.apply(text);
      expect(result.text).toBe("Sedes complete ".repeat(4096));
      expect(result.matches).toEqual([{ ruleId: "name", count: 4096 }]);
    }
  });

  it("constructs and applies 100 Unicode class expressions repeatedly without a fixed native heap", () => {
    const rules = Array.from({ length: 100 }, (_, index) => rule(`\\p{L}{${index + 1}}x`, "translated", `unicode-${index}`));
    const text = "猫".repeat(100) + "x";
    for (let attempt = 0; attempt < 3; attempt++) {
      const engine = create(...rules);
      expect(engine.apply(text).text).toBe("translated");
      expect(engine.apply("😀" + text).text).toBe("😀translated");
    }
  });

  it("validates and repeatedly runs complex Unicode phrase rules across two full sets", () => {
    const rules = Array.from({ length: 100 }, (_, index) => rule(`\\b(?:\\p{L}+\\s+){0,8}zz${index}\\b`, `translated-${index}`, `phrase-${index}`));
    const text = "ordinary words ".repeat(273) + "zz42";
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const config of rules) expect(inspectSubstitutionPattern(config.pattern, config.case_insensitive).error).toBeUndefined();
      const engine = createEngine({ default_rule_set: "common", rule_sets: { common: rules, other: rules } });
      for (const selection of ["common", "other"]) {
        const result = engine.apply(text, selection);
        expect(result.text).toBe("ordinary words ".repeat(269) + "translated-42");
        expect(result.matches).toEqual([{ ruleId: "phrase-42", count: 1 }]);
      }
    }
  }, 15_000);

  it("validates, constructs, and applies a representative maximum-size configuration", () => {
    // 3,200 independent compiled expressions, 259,200 total instructions: close
    // to the aggregate limit, with the maximum number of sets and rules.
    const pattern = "a".repeat(79);
    const config = ConfigSchema.parse({
      server: { listen: "127.0.0.1:1" }, auth: { tokens_file: "/unused" },
      models: [{ id: "stt", task: "transcription", provider: "parakeet", provider_config: { python: "python3" } }],
      clients: [{ id: "test", token_ref: "test", allowed_models: ["stt"] }],
      [`${task}_substitutions`]: { default_rule_set: "set-0", rule_sets: Object.fromEntries(Array.from({ length: 32 }, (_, set) => [`set-${set}`, Array.from({ length: 100 }, (_, index) => rule(pattern, `result-${set}`, `rule-${index}`))])) },
    });
    const engine = createEngine(config[`${task}_substitutions`]);
    for (let set = 0; set < 32; set++) expect(engine.apply(pattern, `set-${set}`).text).toBe(`result-${set}`);
    expect(engine.apply("😀" + pattern + " tail").text).toBe("😀result-0 tail");
  }, 15_000);
});
