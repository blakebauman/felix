/**
 * Tiny recursive-descent arithmetic evaluator used by the calculator tool.
 *
 * Supports `+ - * /`, unary `-`, parentheses, integer and decimal literals.
 * Reject everything else. Replaces the previous `new Function(...)` approach
 * so a defense-in-depth lapse on the input sanitizer doesn't open a code-
 * execution surface.
 *
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := number | '(' expr ')' | ('+' | '-') factor
 */

interface ParseState {
  s: string;
  i: number;
}

function skipWs(p: ParseState): void {
  while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i += 1;
}

function readNumber(p: ParseState): number {
  skipWs(p);
  const start = p.i;
  while (p.i < p.s.length && /[\d.]/.test(p.s[p.i]!)) p.i += 1;
  const lex = p.s.slice(start, p.i);
  if (!lex) throw new Error(`expected number at position ${start}`);
  const n = Number(lex);
  if (Number.isNaN(n)) throw new Error(`invalid number: ${lex}`);
  return n;
}

function parseFactor(p: ParseState): number {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '+') {
    p.i += 1;
    return parseFactor(p);
  }
  if (c === '-') {
    p.i += 1;
    return -parseFactor(p);
  }
  if (c === '(') {
    p.i += 1;
    const v = parseExpr(p);
    skipWs(p);
    if (p.s[p.i] !== ')') throw new Error(`expected ')' at position ${p.i}`);
    p.i += 1;
    return v;
  }
  return readNumber(p);
}

function parseTerm(p: ParseState): number {
  let v = parseFactor(p);
  while (true) {
    skipWs(p);
    const op = p.s[p.i];
    if (op !== '*' && op !== '/') return v;
    p.i += 1;
    const rhs = parseFactor(p);
    if (op === '/') {
      if (rhs === 0) throw new Error('division by zero');
      v = v / rhs;
    } else {
      v = v * rhs;
    }
  }
}

function parseExpr(p: ParseState): number {
  let v = parseTerm(p);
  while (true) {
    skipWs(p);
    const op = p.s[p.i];
    if (op !== '+' && op !== '-') return v;
    p.i += 1;
    const rhs = parseTerm(p);
    v = op === '+' ? v + rhs : v - rhs;
  }
}

export function evaluateExpression(expression: string): number {
  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error('invalid characters');
  }
  const p: ParseState = { s: expression, i: 0 };
  const v = parseExpr(p);
  skipWs(p);
  if (p.i !== p.s.length) throw new Error(`unexpected trailing input at position ${p.i}`);
  if (!Number.isFinite(v)) throw new Error('non-finite result');
  return v;
}
