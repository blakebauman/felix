/**
 * Memory-quality benchmark.
 *
 * Capture quality lives almost entirely in a prompt, and prompts regress
 * silently: a reworded instruction that starts storing the assistant's own
 * suggestions as user preferences breaks nothing, fails no test, and only
 * surfaces weeks later as an agent confidently acting on things nobody said.
 *
 * So this replays fixed conversations through the capture path, hands the
 * resulting memory to a judge model, and scores three axes that correspond to
 * the ways capture actually goes wrong:
 *
 *   - **signalToNoise** — is what got stored durable and reusable, or is it
 *     one-off trivia, duplicates, and restatements of the task?
 *   - **staleness** — when a fact changed mid-conversation, does memory hold
 *     the LATEST value, or both the old and the new with no way to tell?
 *   - **inferenceVsObservation** — is every entry something actually said, or
 *     is it the model's speculation written down as fact?
 *
 * The model calls are injected rather than imported so the pure parts —
 * replay, parsing, scoring, the floor gate — are unit-testable without any
 * binding, which is what lets CI check the harness even though it can't run
 * the models.
 */

import type { ChatMessage } from '../patterns/types';
import { normalizeFact } from './capture';

/** One scripted exchange. Replayed verbatim; no model produces these. */
export interface BenchConversation {
  id: string;
  description: string;
  turns: Array<{ input: string; reply: string }>;
}

export interface BenchScores {
  signalToNoise: number;
  staleness: number;
  inferenceVsObservation: number;
  notes: string;
}

export interface BenchResult {
  conversation: string;
  facts: string[];
  scores: BenchScores;
}

/**
 * Minimum acceptable average per axis. Below any of these, the run fails.
 *
 * These are measured, not guessed. Four runs on 2026-08-07 against
 * `claude-sonnet-4-6` scored s/n 6.0-6.3, staleness 8.3 every time, and
 * observation 8.3-8.7. Each floor sits about half a point under the worst
 * observed run — wide enough that ordinary judge jitter won't fail CI, tight
 * enough that a real regression does. Signal-to-noise is the noisiest axis
 * and the one to watch: it moved 0.3 across runs with nothing changed.
 *
 * The earlier placeholder floors (5 / 4 / 5) passed with room to spare on
 * every axis and would have waved through a serious regression.
 *
 * Re-measure when the extraction prompt, the judge prompt, or the benchmark
 * model changes — all three move these numbers.
 */
export const DEFAULT_FLOORS: Omit<BenchScores, 'notes'> = {
  signalToNoise: 5.5,
  staleness: 7,
  inferenceVsObservation: 7.5,
};

export const JUDGE_PROMPT = [
  "You judge the quality of an agent's long-term memory produced from a conversation.",
  'You are given the conversation and the list of facts the agent chose to store.',
  '',
  'Score each axis 0-10:',
  '- signalToNoise: are the stored facts durable and reusable in FUTURE conversations, rather',
  '  than one-off trivia, duplicates, restatements of the task, or secrets that should never',
  '  be stored?',
  '- staleness: when a fact CHANGED during the conversation, does the stored set reflect the',
  '  latest state? Storing both the old and new value with no way to tell them apart is a',
  '  failure on this axis.',
  '- inferenceVsObservation: is each entry something actually stated or observed, rather than',
  "  the model's speculation dressed up as fact? A stored preference the user never expressed",
  '  scores 0 here regardless of how plausible it is.',
  '',
  'An EMPTY memory is not automatically bad: score signalToNoise low only if the conversation',
  'clearly contained durable facts worth keeping. A conversation with nothing memorable in it',
  'SHOULD produce nothing.',
  '',
  'Reply with ONLY a JSON object:',
  '{"signalToNoise": n, "staleness": n, "inferenceVsObservation": n, "notes": "one sentence"}',
].join('\n');

/** Clamp to the documented range so a wild score can't skew an average. */
function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Parse a judge reply. Returns null when it can't be read at all — the caller
 * reports that as a bench failure rather than silently scoring it zero, since
 * an unparseable judge is a broken harness, not a bad memory.
 */
export function parseJudgeVerdict(raw: string): BenchScores | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    // EVERY axis must be present. A reply missing one is a formatting slip in
    // the judge, and scoring the absent axis 0 would report a harness break as
    // a memory regression — which is exactly the wrong thing to send someone
    // debugging.
    if (
      obj.signalToNoise === undefined ||
      obj.staleness === undefined ||
      obj.inferenceVsObservation === undefined
    ) {
      return null;
    }
    return {
      signalToNoise: clampScore(obj.signalToNoise),
      staleness: clampScore(obj.staleness),
      inferenceVsObservation: clampScore(obj.inferenceVsObservation),
      notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 300) : '',
    };
  } catch {
    return null;
  }
}

/** Turn a scripted conversation into the message array capture would see. */
export function conversationMessages(conversation: BenchConversation): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of conversation.turns) {
    messages.push({ role: 'user', content: turn.input });
    messages.push({ role: 'assistant', content: turn.reply });
  }
  return messages;
}

/**
 * Replay one conversation turn-by-turn, accumulating everything capture chose
 * to store.
 *
 * Turn-by-turn rather than all at once on purpose: that is how capture runs in
 * production, and it is the only way the staleness axis means anything — a
 * fact superseded three turns later has to have been stored first.
 */
export async function replayConversation(
  conversation: BenchConversation,
  capture: (messages: ChatMessage[]) => Promise<string[]>,
): Promise<string[]> {
  const facts: string[] = [];
  const seen = new Set<string>();
  const soFar: ChatMessage[] = [];
  for (const turn of conversation.turns) {
    soFar.push({ role: 'user', content: turn.input });
    soFar.push({ role: 'assistant', content: turn.reply });
    // Capture re-reads the whole exchange each turn, so a fact established
    // early is re-extracted on every later turn. Production drops those
    // re-writes in `alreadyStored`; without the same filter here the benchmark
    // scores a pile of verbatim repeats no real store would ever hold, and the
    // judge marks it down for duplication that does not exist in production.
    //
    // It deliberately uses capture's OWN normalization rather than a second
    // copy of the rule, so the two cannot drift apart — and it is deliberately
    // no smarter than production: near-duplicate PARAPHRASES survive here
    // exactly as they survive a real write, because catching those is
    // consolidation's job and the benchmark should show the gap.
    for (const fact of await capture([...soFar])) {
      const key = normalizeFact(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts;
}

/** Average each axis across results. Empty input scores zero, not NaN. */
export function averageScores(results: BenchResult[]): Omit<BenchScores, 'notes'> {
  if (results.length === 0) {
    return { signalToNoise: 0, staleness: 0, inferenceVsObservation: 0 };
  }
  const sum = results.reduce(
    (acc, r) => ({
      signalToNoise: acc.signalToNoise + r.scores.signalToNoise,
      staleness: acc.staleness + r.scores.staleness,
      inferenceVsObservation: acc.inferenceVsObservation + r.scores.inferenceVsObservation,
    }),
    { signalToNoise: 0, staleness: 0, inferenceVsObservation: 0 },
  );
  return {
    signalToNoise: sum.signalToNoise / results.length,
    staleness: sum.staleness / results.length,
    inferenceVsObservation: sum.inferenceVsObservation / results.length,
  };
}

/** Axes scoring below their floor. Empty means the run passes. */
export function failedAxes(
  averages: Omit<BenchScores, 'notes'>,
  floors: Omit<BenchScores, 'notes'> = DEFAULT_FLOORS,
): string[] {
  const failed: string[] = [];
  for (const axis of ['signalToNoise', 'staleness', 'inferenceVsObservation'] as const) {
    if (averages[axis] < floors[axis]) failed.push(axis);
  }
  return failed;
}

/** Fixed-width report, so a regression is visible by eye in CI output. */
export function formatReport(
  results: BenchResult[],
  floors: Omit<BenchScores, 'notes'> = DEFAULT_FLOORS,
): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  lines.push(
    `${pad('conversation', 32)} ${pad('s/n', 6)} ${pad('stale', 6)} ${pad('obs', 6)} facts`,
  );
  for (const r of results) {
    lines.push(
      `${pad(r.conversation, 32)} ${pad(r.scores.signalToNoise.toFixed(1), 6)} ` +
        `${pad(r.scores.staleness.toFixed(1), 6)} ` +
        `${pad(r.scores.inferenceVsObservation.toFixed(1), 6)} ${r.facts.length}`,
    );
  }
  const avg = averageScores(results);
  lines.push('');
  lines.push(
    `${pad('AVERAGE', 32)} ${pad(avg.signalToNoise.toFixed(1), 6)} ` +
      `${pad(avg.staleness.toFixed(1), 6)} ${pad(avg.inferenceVsObservation.toFixed(1), 6)}`,
  );
  lines.push(
    `${pad('FLOOR', 32)} ${pad(floors.signalToNoise.toFixed(1), 6)} ` +
      `${pad(floors.staleness.toFixed(1), 6)} ${pad(floors.inferenceVsObservation.toFixed(1), 6)}`,
  );
  const failed = failedAxes(avg, floors);
  lines.push('');
  lines.push(failed.length === 0 ? 'PASS' : `FAIL — below floor: ${failed.join(', ')}`);
  return lines.join('\n');
}

/** Validate a fixture before it is trusted as a benchmark input. */
export function parseConversation(raw: unknown): BenchConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !c.id) return null;
  if (typeof c.description !== 'string' || !c.description) return null;
  if (!Array.isArray(c.turns) || c.turns.length < 2) return null;
  const turns: BenchConversation['turns'] = [];
  for (const t of c.turns) {
    if (!t || typeof t !== 'object') return null;
    const turn = t as Record<string, unknown>;
    if (typeof turn.input !== 'string' || typeof turn.reply !== 'string') return null;
    turns.push({ input: turn.input, reply: turn.reply });
  }
  return { id: c.id, description: c.description, turns };
}
