import { RE2JS, type Matcher } from "re2js";
import { ApiError } from "../api/errors.js";
import type { Config } from "../config/schema.js";

export const MAX_RULE_SETS = 32;
export const MAX_RULES_PER_SET = 100;
export const MAX_RULE_TEXT_LENGTH = 1024;
export const MAX_TRANSCRIPT_BYTES = 65_536;
export const MAX_SUBSTITUTION_MATCHES = 4096;
export const MAX_RULE_PROGRAM_SIZE = 4096;
export const MAX_TOTAL_PROGRAM_SIZE = 262_144;

type RuleConfig = Config["transcription_substitutions"]["rule_sets"][string][number];
type CompiledRule = { config: RuleConfig; expression: RE2JS };
type Candidate = { start: number; end: number };

export interface SubstitutionResult {
  text: string;
  ruleSet: string | null;
  matches: Array<{ ruleId: string; count: number }>;
}

function compile(pattern: string, caseInsensitive: boolean): RE2JS {
  return RE2JS.compile(pattern, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0);
}

export function isWellFormedUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Reject unsupported syntax and common empty-match expressions at startup. */
export function inspectSubstitutionPattern(pattern: string, caseInsensitive: boolean): { error?: string; programSize: number } {
  if (pattern.length > MAX_RULE_TEXT_LENGTH) return { error: "Substitution expression exceeds the configured length limit", programSize: 0 };
  if (!isWellFormedUnicode(pattern)) return { error: "Substitution expressions must contain well-formed Unicode", programSize: 0 };
  let expression: RE2JS;
  try {
    expression = compile(pattern, caseInsensitive);
  } catch {
    // Engine diagnostics include the expression, which may contain private vocabulary.
    return { error: "Invalid or unsupported RE2 expression", programSize: 0 };
  }
  const programSize = expression.programSize();
  if (programSize > MAX_RULE_PROGRAM_SIZE) return { error: `Substitution expression exceeds the ${MAX_RULE_PROGRAM_SIZE}-instruction compiled program limit`, programSize };
  // Empty matches can depend on anchors or word boundaries. These probes cover
  // those common cases; the runtime also rejects any empty match it encounters.
  for (const probe of ["", "a", " ", "\n", "aa a\na !a!\n\n"]) {
    const matcher = expression.matcher(probe);
    while (matcher.find()) {
      if (matcher.start() === matcher.end()) return { error: "Substitution expressions must not match empty text", programSize };
    }
  }
  return { programSize };
}

function failure(code: string, message: string): ApiError {
  return new ApiError(500, "server_error", `transcription_substitution_${code}`, message);
}

function isUnicodeBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
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
    if (!isWellFormedUnicode(text)) throw failure("invalid_unicode", "The transcript contains malformed Unicode");

    // Matchers retain the original UTF-16 string without copying or re-encoding
    // it. Group-zero offsets are directly usable by JavaScript string slicing.
    const matchers = rules.map(rule => rule.expression.matcher(text));
    let candidateCount = 0;
    const search = (matcher: Matcher, from: number): Candidate | null => {
      if (!matcher.find(from)) return null;
      const start = matcher.start();
      const end = matcher.end();
      // Escaped surrogate literals can trigger a RE2JS literal fast path that
      // splits a valid pair. Reject those spans instead of corrupting Unicode.
      if (!isUnicodeBoundary(text, start) || !isUnicodeBoundary(text, end)) throw failure("invalid_match", "A transcription substitution expression returned invalid text offsets");
      if (start === end) throw failure("empty_match", "A transcription substitution expression matched empty text");
      if (++candidateCount > MAX_SUBSTITUTION_MATCHES) throw failure("work_limit", "The transcript exceeds the substitution processing limit");
      return { start, end };
    };

    const candidates = matchers.map(matcher => search(matcher, 0));
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
        if (candidates[index] && candidates[index]!.start < cursor) candidates[index] = search(matchers[index]!, cursor);
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
