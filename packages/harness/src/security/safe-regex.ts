/**
 * Compile an operator-supplied regex with catastrophic-backtracking guards.
 *
 * Any pattern that arrives from a manifest, a federation bundle, or a REST
 * write is attacker-adjacent input: a Worker isolate has a CPU budget, and a
 * pattern like `(a+)+$` turns a 30-character subject into an effectively
 * infinite match. `new RegExp` alone gives no protection, so every place that
 * compiles a stored pattern MUST go through this helper rather than calling
 * the constructor directly.
 *
 * The guards are deliberately conservative — they reject constructs that
 * *enable* exponential backtracking rather than trying to prove a given
 * pattern is safe:
 *
 *   - length cap, so a pathological pattern can't be arbitrarily large;
 *   - no backreferences (`\1`, `\k<name>`) — they force the engine to retry
 *     alternatives it would otherwise discard;
 *   - no lookarounds (`(?=`, `(?!`, `(?<=`, `(?<!`) — nested quantifiers
 *     hide inside them where the scan below cannot see them;
 *   - no quantifier applied to a group that is itself quantified or contains
 *     an alternation — this is the `(a+)+` / `(a|a)*` shape that produces the
 *     exponential blowup.
 *
 * The cost is expressiveness: some safe patterns are rejected. That trade is
 * correct for a control-plane input — an operator can rewrite the rule, but a
 * hung isolate takes the request down with it.
 */

/** Upper bound on a stored pattern. Long enough for real rules, short enough to bound compile cost. */
export const MAX_PATTERN_CHARS = 256;

/**
 * Compile `pattern` or throw. `flags` is passed to `RegExp` verbatim — callers
 * that match case-insensitively pass `'i'`.
 *
 * @throws Error when the pattern is empty, over-long, or uses a rejected construct.
 */
export function compileSafeRegex(pattern: string, flags = ''): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  }
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) {
    throw new Error('backreferences and lookarounds are not supported');
  }

  // Single left-to-right scan tracking group nesting. `closed` remembers the
  // group that just ended so a quantifier immediately after `)` can be judged
  // against that group's contents; `previousQuantifier` catches stacked
  // quantifiers (`a++`, `a*?` in the ReDoS-relevant sense).
  const groups: Array<{ quantified: boolean; alternation: boolean }> = [];
  let escaped = false;
  let inClass = false;
  let previousQuantifier = false;
  let closed: { quantified: boolean; alternation: boolean } | null = null;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    // Character classes are atomic for our purposes — `[a-z]` can't nest a
    // quantified group, and `(`/`|` inside a class are literals.
    if (ch === '[') {
      inClass = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;

    if (ch === '(') {
      groups.push({ quantified: false, alternation: false });
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === '|') {
      if (groups.length) groups[groups.length - 1]!.alternation = true;
      previousQuantifier = false;
      closed = null;
      continue;
    }
    if (ch === ')') {
      closed = groups.pop() ?? { quantified: false, alternation: false };
      previousQuantifier = false;
      continue;
    }

    // `?` directly after `(` is a group modifier (`(?:`), not a quantifier.
    const quantifier =
      ch === '*' || ch === '+' || (ch === '?' && pattern[i - 1] !== '(') || ch === '{';
    if (quantifier) {
      if (previousQuantifier || (closed && (closed.quantified || closed.alternation))) {
        throw new Error('nested or ambiguous repetition is not supported');
      }
      if (groups.length) groups[groups.length - 1]!.quantified = true;
      previousQuantifier = true;
      closed = null;
      continue;
    }

    previousQuantifier = false;
    closed = null;
  }

  return new RegExp(pattern, flags);
}

/** True when `pattern` compiles under the guards above. Never throws. */
export function isSafeRegex(pattern: string, flags = ''): boolean {
  try {
    compileSafeRegex(pattern, flags);
    return true;
  } catch {
    return false;
  }
}
