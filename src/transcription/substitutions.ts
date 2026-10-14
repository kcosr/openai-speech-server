import { RE2 } from "re2-wasm";
import { ApiError } from "../api/errors.js";
import type { Config } from "../config/schema.js";

export const MAX_RULE_SETS = 32;
export const MAX_RULES_PER_SET = 100;
export const MAX_RULE_TEXT_LENGTH = 1024;
export const MAX_TRANSCRIPT_BYTES = 65_536;
export const MAX_SUBSTITUTION_MATCHES = 4096;
export const MAX_SUBSTITUTION_WORK_BYTES = 16 * 1024 * 1024;

type RuleConfig = Config["transcription_substitutions"]["rule_sets"][string][number];
type CompiledRule = { config: RuleConfig; expression: RE2 };
type Candidate = { start: number; end: number; endCodePoint: number };

export interface SubstitutionResult {
  text: string;
  ruleSet: string | null;
  matches: Array<{ ruleId: string; count: number }>;
}

function compile(pattern: string, caseInsensitive: boolean): RE2 {
  return new RE2(pattern, caseInsensitive ? "giu" : "gu");
}

/** Reject unsupported syntax and common empty-match expressions at startup. */
export function validateSubstitutionPattern(pattern: string, caseInsensitive: boolean): string | undefined {
  if (pattern.length > MAX_RULE_TEXT_LENGTH) return "Substitution expression exceeds the configured length limit";
  let quoted = false;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "\\") continue;
    const escaped = pattern[index + 1];
    if (quoted) {
      if (escaped === "E") { quoted = false; index++; }
    } else {
      // RE2's raw-byte escape can split UTF-8 characters; this binding only
      // exposes code-point offsets. Escaped backslashes and quoted text are safe.
      if (escaped === "C") return "The RE2 raw-byte escape is not supported";
      if (escaped === "Q") quoted = true;
      index++;
    }
  }
  let expression: RE2;
  try {
    expression = compile(pattern, caseInsensitive);
  } catch {
    // Engine diagnostics include the expression, which may contain private vocabulary.
    return "Invalid or unsupported RE2 expression";
  }
  // Empty matches can depend on anchors or word boundaries. These probes cover
  // those common cases; the runtime also rejects any empty match it encounters.
  for (const probe of ["", "a", " ", "\n", "aa a\na !a!\n\n"]) {
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(probe))) {
      if (!match[0]) return "Substitution expressions must not match empty text";
      // re2-wasm indices are code points, despite its UTF-16 lastIndex update.
      expression.lastIndex = match.index + Array.from(match[0]).length;
    }
  }
  return undefined;
}

function failure(code: string, message: string): ApiError {
  return new ApiError(500, "server_error", `transcription_substitution_${code}`, message);
}

/** Applies one configured dictionary to the original final transcript. */
export class TranscriptSubstitutions {
  private readonly defaultRuleSet: string | null;
  private readonly ruleSets = new Map<string, CompiledRule[]>();

  constructor(config: Config["transcription_substitutions"]) {
    this.defaultRuleSet = config.default_rule_set;
    for (const [name, rules] of Object.entries(config.rule_sets)) {
      this.ruleSets.set(name, rules.map(rule => ({ config: rule, expression: compile(rule.pattern, rule.case_insensitive) })));
    }
  }

  apply(text: string, selection?: string | null): SubstitutionResult {
    const ruleSet = selection === undefined ? this.defaultRuleSet : selection;
    if (ruleSet === null) return { text, ruleSet, matches: [] };
    const rules = this.ruleSets.get(ruleSet);
    if (!rules) throw failure("configuration", "The selected transcription substitution rule set is unavailable");
    if (rules.length === 0) return { text, ruleSet, matches: [] };
    const inputBytes = Buffer.byteLength(text, "utf8");
    if (inputBytes > MAX_TRANSCRIPT_BYTES) throw failure("input_limit", "The transcript exceeds the substitution input limit");

    // re2-wasm returns code-point offsets. Translate them before slicing JS
    // strings, and override its lastIndex after every search (astral matches
    // otherwise advance by the wrong number of code points).
    const utf16Offsets = [0];
    for (const character of text) utf16Offsets.push(utf16Offsets[utf16Offsets.length - 1]! + character.length);

    let workBytes = 0;
    let candidateCount = 0;
    const search = (rule: CompiledRule, fromCodePoint: number): Candidate | null => {
      // Every exec converts the full string into WASM memory, even when it starts
      // at a later offset. Bound that aggregate work as well as match count.
      workBytes += inputBytes;
      if (workBytes > MAX_SUBSTITUTION_WORK_BYTES) throw failure("work_limit", "The transcript exceeds the substitution processing limit");
      rule.expression.lastIndex = fromCodePoint;
      const match = rule.expression.exec(text);
      if (!match) return null;
      if (!match[0]) throw failure("empty_match", "A transcription substitution expression matched empty text");
      if (++candidateCount > MAX_SUBSTITUTION_MATCHES) throw failure("work_limit", "The transcript exceeds the substitution processing limit");
      const endCodePoint = match.index + Array.from(match[0]).length;
      const start = utf16Offsets[match.index];
      const end = utf16Offsets[endCodePoint];
      if (start === undefined || end === undefined || text.slice(start, end) !== match[0]) throw failure("invalid_match", "A transcription substitution expression returned invalid text offsets");
      return { start, end, endCodePoint };
    };

    const candidates = rules.map(rule => search(rule, 0));
    const counts = rules.map(() => 0);
    const chunks: string[] = [];
    let cursor = 0;
    let outputBytes = 0;
    const append = (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_TRANSCRIPT_BYTES) throw failure("output_limit", "The corrected transcript exceeds the substitution output limit");
      chunks.push(chunk);
    };
    while (true) {
      let selected = -1;
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        // Keeping the first equal start makes configuration order the tie-breaker.
        if (candidate && (selected === -1 || candidate.start < candidates[selected]!.start)) selected = index;
      }
      if (selected === -1) break;
      const candidate = candidates[selected]!;
      append(text.slice(cursor, candidate.start));
      append(rules[selected]!.config.replacement); // Literal text, never $-expansion.
      counts[selected]!++;
      cursor = candidate.end;
      for (let index = 0; index < candidates.length; index++) {
        // Search again after an overlap: a discarded match might hide another
        // valid occurrence starting at the new cursor. Keep the full original
        // string so ^ and word boundaries retain their original context.
        if (candidates[index] && candidates[index]!.start < cursor) candidates[index] = search(rules[index]!, candidate.endCodePoint);
      }
    }
    append(text.slice(cursor));
    return {
      text: chunks.join(""),
      ruleSet,
      matches: rules.flatMap((rule, index) => counts[index]! > 0 ? [{ ruleId: rule.config.id, count: counts[index]! }] : []),
    };
  }
}
