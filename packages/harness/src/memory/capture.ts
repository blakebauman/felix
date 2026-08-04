/**
 * Automatic post-turn memory capture.
 *
 * Long-term memory only worked if the model remembered to call
 * `memory_remember`, which makes recall depend on the model noticing that
 * something was worth keeping — the moment it is busy doing the actual task.
 * In practice memory stayed empty and `memory_recall` returned nothing.
 *
 * This runs after a turn completes, asks a small model which durable facts the
 * exchange produced, and writes them. Fire-and-forget: capture failing must
 * never fail the turn the user already got an answer to.
 *
 * The extraction prompt does most of the work, and two of its rules matter more
 * than the rest:
 *
 * - **Provenance.** A preference or instruction counts only when the USER said
 *   it. Models will happily turn their own suggestion ("I could summarize these
 *   weekly for you") into a remembered user preference, and that fabricated
 *   fact then steers every later turn with no trace of where it came from.
 * - **Nothing is free to store.** Every stored fact costs recall precision
 *   later, so one-off trivia, restatements of the current task, and anything
 *   already obvious are excluded. An empty capture is a correct outcome.
 */

import { recordEvent } from '../audit/store';
import { getContext, isUnattended } from '../context';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import type { ChatMessage } from '../patterns/types';
import type { MemoryRecord, MemoryStore } from './store';

/** Sentinel the model returns when an exchange produced nothing worth keeping. */
export const NOTHING_TO_CAPTURE = 'NONE';

export const EXTRACTION_PROMPT = [
  'You extract durable facts worth remembering about the user across FUTURE conversations.',
  '',
  'Output ONLY a markdown bullet list (`- fact`), one concise standalone fact per line,',
  'written in the third person. Each line must stand on its own without the conversation',
  'for context — "prefers metric units" is useless; "the user prefers metric units" is not.',
  '',
  "PROVENANCE: a preference, intent, or instruction is a valid fact ONLY when the user's own",
  "message states it. Never derive one from the assistant's reply, from a suggestion the",
  'assistant made, or from what the assistant assumed. If the assistant proposed something and',
  'the user did not agree to it, there is no fact.',
  '',
  'EXCLUDE: secrets, credentials, tokens, and keys; one-off trivia specific to this task;',
  'restatements of what was just asked; anything obvious from the system prompt; and mechanics',
  'that can be looked up when needed (endpoints, file paths, parameter names).',
  '',
  `If nothing is worth remembering, output exactly: ${NOTHING_TO_CAPTURE}`,
].join('\n');

/**
 * Extra rule for runs with no human in them.
 *
 * A cron tick or a replay has no user speaking, so anything that looks like a
 * preference is really the model narrating its own behavior. Storing those
 * would let an automated run quietly rewrite what the agent believes about a
 * person who was never there.
 */
export const UNATTENDED_ADDENDUM = [
  '',
  'This exchange was produced by an automated run — no human spoke in it. Output NO preference,',
  'intent, or instruction facts about any person. Only durable facts about the world or the',
  'system that the exchange established are eligible.',
].join('\n');

export interface CaptureConfig {
  enabled: boolean;
  model: string;
  max_facts: number;
  min_chars: number;
}

/** Parse the model's bullet list into clean fact strings. */
export function parseFacts(raw: string, maxFacts: number): string[] {
  const text = raw.trim();
  if (!text || text.toUpperCase().startsWith(NOTHING_TO_CAPTURE)) return [];
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*')) continue;
    const fact = trimmed.replace(/^[-*]\s*/, '').trim();
    // A model that decides mid-list there's nothing to say emits the sentinel
    // as a bullet; treat that as the sentinel, not as a fact literally
    // reading "NONE".
    if (!fact || fact.toUpperCase() === NOTHING_TO_CAPTURE) continue;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

/**
 * Neutralize lines that would read as a role marker in the flattened
 * transcript.
 *
 * The extraction prompt's provenance rule ("only when the USER said it") is
 * enforced by the model reading `user:` / `assistant:` prefixes, so a content
 * line that itself begins with one lets attacker-controlled text forge a user
 * turn and get itself stored as a durable fact about a person. Tool results
 * are already excluded, but an assistant turn can quote one verbatim, so the
 * spoofing surface survives that exclusion.
 *
 * This closes the structural hole; it does not make the extractor immune to a
 * quoted instruction that is merely persuasive. Prompt-injection screening
 * (`spec.content_screening`) is the control for that, and it runs earlier.
 */
function stripRoleMarkers(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^\s*(user|assistant|system|tool)\s*:/i, '$1\u200b:'))
    .join('\n');
}

/**
 * Render the exchange the extractor reads.
 *
 * Only user and assistant turns: tool calls and results are the mechanics of
 * how an answer was produced, and feeding them in reliably produces "facts"
 * about the tooling rather than about the user.
 */
export function renderExchange(messages: readonly ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = (m.content ?? '').trim();
    if (!content) continue;
    lines.push(`${m.role}: ${stripRoleMarkers(content)}`);
  }
  const joined = lines.join('\n');
  // Keep the TAIL: the most recent turns are the ones whose facts are still
  // current, and an over-long exchange is usually long because of earlier
  // context the later turns already superseded.
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/** Ask the model which durable facts this exchange produced. */
export async function extractFacts(
  env: Env,
  config: CaptureConfig,
  messages: readonly ChatMessage[],
): Promise<string[]> {
  const ai = env.AI;
  if (!ai) return [];
  const exchange = renderExchange(messages, 6_000);
  if (exchange.length < config.min_chars) return [];

  const system = isUnattended() ? EXTRACTION_PROMPT + UNATTENDED_ADDENDUM : EXTRACTION_PROMPT;
  try {
    const reply = (await ai.run(
      config.model as keyof AiModels,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: exchange },
        ],
        max_tokens: 400,
        temperature: 0,
      } as never,
    )) as { response?: unknown };
    const raw = reply.response;
    const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    return parseFacts(text, config.max_facts);
  } catch (err) {
    recordCounter('orchestrator_memory_capture_errors', {
      manifest_id: getContext()?.manifestId ?? 'unknown',
    });
    console.warn('memory capture: extraction failed', (err as Error).message);
    return [];
  }
}

/**
 * Extract and store. Returns what was written so callers (and the benchmark)
 * can see the result; never throws.
 */
export async function captureMemories(
  env: Env,
  config: CaptureConfig,
  store: MemoryStore,
  messages: readonly ChatMessage[],
): Promise<MemoryRecord[]> {
  if (!config.enabled) return [];
  const facts = await extractFacts(env, config, messages);
  if (facts.length === 0) return [];

  const written: MemoryRecord[] = [];
  const skipped: string[] = [];
  for (const fact of facts) {
    // The extractor sees a window of recent turns, so a durable fact re-appears
    // in its input on every turn until it scrolls out — and would be written
    // again each time, inflating the table and splitting recall's top-K across
    // near-identical rows. Check what is already stored before writing.
    if (await alreadyStored(store, fact)) {
      skipped.push(fact);
      continue;
    }
    const rec = await store.remember(fact, 'fact');
    if (rec) written.push(rec);
  }

  const manifestId = getContext()?.manifestId ?? 'unknown';
  if (written.length > 0 || skipped.length > 0) {
    const ctx = getContext();
    // Capture permanently changes what the agent believes about a tenant's
    // users, with no tool call to attribute it to — so it needs its own audit
    // row, or the only trace is an unattributed counter.
    recordEvent({
      tenantId: ctx?.auth.principal.tenantId ?? 'default',
      eventType: 'memory_captured',
      principalSubject: ctx?.auth.principal.subject ?? '',
      manifestId,
      status: written.length > 0 ? 'stored' : 'duplicate',
      payload: {
        stored: written.length,
        skipped_duplicates: skipped.length,
        unattended: isUnattended(),
        // The facts themselves: this is the same text going into the store, and
        // without it an operator can't tell WHAT the agent decided to believe.
        facts: written.map((w) => w.text.slice(0, 300)),
      },
    });
  }
  recordCounter('orchestrator_memory_captured', {
    manifest_id: manifestId,
    count: String(written.length),
  });
  return written;
}

/** Normalize for comparison — casing and punctuation shouldn't defeat dedup. */
function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when this fact is already in the store.
 *
 * Uses recall's own similarity search to fetch nearby rows, then compares
 * normalized text: an embedding neighbour is not necessarily the same claim
 * ("the user is in Berlin" and "the user is in Lisbon" sit close together and
 * are opposites), so nearness alone must not suppress a write. Reconciling
 * facts that genuinely conflict is consolidation's job, not capture's.
 */
async function alreadyStored(store: MemoryStore, fact: string): Promise<boolean> {
  try {
    const near = await store.recall(fact, 5);
    const target = normalizeFact(fact);
    return near.some((m) => normalizeFact(m.text) === target);
  } catch {
    // A recall failure must not block the write — losing a fact is worse than
    // storing it twice.
    return false;
  }
}
