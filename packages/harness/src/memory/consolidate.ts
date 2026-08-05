/**
 * Memory consolidation — reconciling a pool that capture only ever appends to.
 *
 * Capture writes facts as it sees them and deliberately does not suppress a
 * CONFLICTING one, because embedding nearness is not sameness: "the user is in
 * Berlin" and "the user is in Lisbon" sit close together and mean opposite
 * things, so refusing the second would silently preserve the stale answer.
 * Correct at write time, but it means a long-lived pool accumulates
 * contradictions with no signal about which entry is current.
 *
 * This is the pass that resolves them. It hands a model the pool as a numbered
 * list and accepts a small, closed instruction language back:
 *
 *     UPDATE 3: the user is in Lisbon
 *     DELETE 7
 *     ADD: the user reviews invoices on Fridays
 *     NONE
 *
 * A grammar rather than "rewrite the whole memory" for one reason: a rewrite
 * makes every fact's survival depend on the model reproducing it verbatim, so
 * a truncated or distracted response silently deletes memory it never
 * mentioned. With operations, anything the model does not name is left exactly
 * as it was — the failure mode of a bad response is that nothing happens.
 *
 * Every operation is bounds-checked against the list that was actually sent.
 * The model is choosing what to delete from a tenant's memory, and an
 * off-by-one or hallucinated index would delete the wrong fact — silently, and
 * with no way to tell afterwards which one it was.
 */

import { recordEvent } from '../audit/store';
import { getContext } from '../context';
import type { Env } from '../env';
import { recordCounter } from '../observability/metrics';
import type { MemoryRecord, MemoryStore } from './store';

/** Returned when the pool needs no changes. */
export const NOTHING_TO_CONSOLIDATE = 'NONE';

export const CONSOLIDATION_PROMPT = [
  "You are tidying an agent's long-term memory. You are given a numbered list of remembered",
  'facts about a user, oldest first. Facts were appended over time and were never reconciled,',
  'so the list may contain entries that contradict each other, duplicate each other, or have',
  'been superseded by something later.',
  '',
  'Reply with ONLY these operations, one per line:',
  '  UPDATE <n>: <corrected fact>   — replace fact n with a corrected version',
  '  DELETE <n>                     — remove fact n entirely',
  '  ADD: <new fact>                — add a fact the list should contain but does not',
  '',
  'Use UPDATE when a fact is nearly right but stale or imprecise. Use DELETE for a fact that a',
  'later entry supersedes, or that duplicates another entry — delete the OUTDATED or REDUNDANT',
  'one and keep the current one. Use ADD sparingly: only to merge several existing entries into',
  'one clearer fact, never to introduce something the list does not already support.',
  '',
  'Do NOT invent facts. Do NOT rewrite entries that are simply fine. Anything you do not',
  'mention is kept unchanged, so it is safe to leave most of the list alone.',
  '',
  `If the list needs no changes, reply with exactly: ${NOTHING_TO_CONSOLIDATE}`,
].join('\n');

export type ConsolidationOp =
  | { kind: 'update'; index: number; text: string }
  | { kind: 'delete'; index: number }
  | { kind: 'add'; text: string };

export interface ConsolidateConfig {
  enabled: boolean;
  model: string;
  after_facts: number;
  max_facts: number;
}

/** What one applied operation actually did, for the audit trail. */
export interface AppliedOp {
  op: 'update' | 'delete' | 'add';
  /** Row removed or replaced, when there was one. */
  id?: string;
  before?: string;
  after?: string;
}

export interface ConsolidationOutcome {
  updated: number;
  deleted: number;
  added: number;
  /** Operations that named a fact outside the list, or were unreadable. */
  rejected: number;
  /** Per-operation detail — this pass deletes data, so what it did is recorded. */
  applied: AppliedOp[];
}

/**
 * Parse the model's reply into operations.
 *
 * `total` is the size of the list that was sent: an index outside it is
 * rejected rather than clamped, because clamping would silently retarget a
 * delete onto a fact the model never chose.
 */
export function parseConsolidationOps(
  raw: string,
  total: number,
): { ops: ConsolidationOp[]; rejected: number } {
  const text = raw.trim();
  const ops: ConsolidationOp[] = [];
  let rejected = 0;
  if (!text || text.toUpperCase().startsWith(NOTHING_TO_CONSOLIDATE)) return { ops, rejected };

  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= total;

  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^[-*]\s*/, '');
    if (!trimmed || trimmed.toUpperCase() === NOTHING_TO_CONSOLIDATE) continue;

    const update = /^UPDATE\s+(\d+)\s*:\s*(.+)$/i.exec(trimmed);
    if (update) {
      const index = Number.parseInt(update[1] as string, 10);
      const value = (update[2] as string).trim();
      if (inRange(index) && value) ops.push({ kind: 'update', index, text: value });
      else rejected += 1;
      continue;
    }

    const del = /^DELETE\s+(\d+)\s*$/i.exec(trimmed);
    if (del) {
      const index = Number.parseInt(del[1] as string, 10);
      if (inRange(index)) ops.push({ kind: 'delete', index });
      else rejected += 1;
      continue;
    }

    const add = /^ADD\s*:\s*(.+)$/i.exec(trimmed);
    if (add) {
      const value = (add[1] as string).trim();
      if (value) ops.push({ kind: 'add', text: value });
      else rejected += 1;
      continue;
    }

    // Anything else is prose the model added around its answer. Count it so a
    // model that has stopped following the format is visible rather than
    // looking like a pool that never needs changes.
    rejected += 1;
  }

  // One index, one fate. A model that both updates and deletes the same entry
  // has contradicted itself; deleting wins, since keeping a fact the model
  // wanted gone is the worse error.
  const deleted = new Set(ops.filter((o) => o.kind === 'delete').map((o) => o.index));
  const deduped = ops.filter((o) => !(o.kind === 'update' && deleted.has(o.index)));
  return { ops: deduped, rejected };
}

/** Longest fact text shown to the consolidator; longer entries are truncated. */
const MAX_FACT_CHARS = 400;

/**
 * Render the numbered list the model reasons over.
 *
 * Fact text is flattened to a single line first. A stored fact is
 * LLM-extracted from user-influenced content, so one containing an embedded
 * newline followed by `7. …` would forge an extra numbered entry inside the
 * list — and the model, reasoning about a fake entry, would issue a DELETE for
 * an index that bounds-checks as valid but points at a real, unrelated fact.
 * The index check cannot catch that, because the index really is in range;
 * the only fix is to make the numbering unforgeable.
 */
export function renderFactList(facts: readonly MemoryRecord[]): string {
  return facts
    .map((f, i) => {
      const flat = f.text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
      return `${i + 1}. ${flat}`;
    })
    .join('\n');
}

/**
 * Cap on destructive operations in one pass, as a fraction of the pool.
 *
 * A pass that wants to delete most of a pool is not tidying it, and the
 * plausible causes — a model that misread the list, or one steered by a
 * poisoned fact — both argue for refusing rather than complying. Consolidation
 * runs unattended with no approval gate, so this is the only thing bounding
 * how much memory a single bad response can destroy. Whatever is genuinely
 * redundant will still be removed over subsequent passes.
 */
const MAX_DESTRUCTIVE_FRACTION = 0.5;

/** Trim destructive ops down to the per-pass ceiling, keeping the earliest. */
export function capDestructiveOps(
  ops: readonly ConsolidationOp[],
  poolSize: number,
): { ops: ConsolidationOp[]; dropped: number } {
  const ceiling = Math.max(1, Math.floor(poolSize * MAX_DESTRUCTIVE_FRACTION));
  let destructive = 0;
  const kept: ConsolidationOp[] = [];
  let dropped = 0;
  for (const op of ops) {
    if (op.kind === 'delete' || op.kind === 'update') {
      if (destructive >= ceiling) {
        dropped += 1;
        continue;
      }
      destructive += 1;
    }
    kept.push(op);
  }
  return { ops: kept, dropped };
}

/**
 * Apply operations to the store.
 *
 * An UPDATE is a delete plus a write rather than an in-place edit: the stored
 * embedding was computed from the old text, so editing the text alone would
 * leave a row that is recalled by its previous meaning.
 */
export async function applyConsolidationOps(
  store: MemoryStore,
  facts: readonly MemoryRecord[],
  ops: readonly ConsolidationOp[],
): Promise<ConsolidationOutcome> {
  const outcome: ConsolidationOutcome = {
    updated: 0,
    deleted: 0,
    added: 0,
    rejected: 0,
    applied: [],
  };

  for (const op of ops) {
    try {
      if (op.kind === 'delete') {
        const target = facts[op.index - 1];
        if (!target) continue;
        // Count what the store actually removed, not what we asked it to. A
        // row that was already gone must not be reported as a deletion — the
        // counts are the only signal an operator has that a pass behaved.
        if (!(await store.forget(target.id))) continue;
        outcome.deleted += 1;
        outcome.applied.push({ op: 'delete', id: target.id, before: target.text });
        continue;
      }
      if (op.kind === 'update') {
        const target = facts[op.index - 1];
        if (!target) continue;
        // Write first, then remove: if the process dies between the two, the
        // pool holds a duplicate rather than having silently lost the fact.
        const written = await store.remember(op.text, target.kind);
        if (!written) continue;
        if (!(await store.forget(target.id))) {
          // The replacement is stored but the original survived. Report it as
          // an add rather than an update — claiming an update would say the
          // old value is gone when it is still there to be recalled.
          outcome.added += 1;
          outcome.applied.push({ op: 'add', after: op.text });
          continue;
        }
        outcome.updated += 1;
        outcome.applied.push({
          op: 'update',
          id: target.id,
          before: target.text,
          after: op.text,
        });
        continue;
      }
      const written = await store.remember(op.text, 'fact');
      if (written) {
        outcome.added += 1;
        outcome.applied.push({ op: 'add', after: op.text });
      }
    } catch (err) {
      outcome.rejected += 1;
      console.warn('memory consolidation: operation failed', (err as Error).message);
    }
  }
  return outcome;
}

/** Ask the model how to reconcile this pool. Never throws. */
export async function proposeConsolidation(
  env: Env,
  config: ConsolidateConfig,
  facts: readonly MemoryRecord[],
): Promise<{ ops: ConsolidationOp[]; rejected: number }> {
  const ai = env.AI;
  if (!ai || facts.length === 0) return { ops: [], rejected: 0 };
  try {
    const reply = (await ai.run(
      config.model as keyof AiModels,
      {
        messages: [
          { role: 'system', content: CONSOLIDATION_PROMPT },
          { role: 'user', content: renderFactList(facts) },
        ],
        max_tokens: 800,
        temperature: 0,
      } as never,
    )) as { response?: unknown };
    const raw = reply.response;
    const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    return parseConsolidationOps(text, facts.length);
  } catch (err) {
    recordCounter('orchestrator_memory_consolidate_errors', {
      manifest_id: getContext()?.manifestId ?? 'unknown',
    });
    console.warn('memory consolidation: model call failed', (err as Error).message);
    return { ops: [], rejected: 0 };
  }
}

/**
 * Consolidate one pool: propose, apply, audit. Assumes a `RequestContext`
 * scoped to the owning tenant is already installed.
 */
export async function consolidatePool(
  env: Env,
  config: ConsolidateConfig,
  store: MemoryStore,
  facts: readonly MemoryRecord[],
  manifestId: string,
): Promise<ConsolidationOutcome> {
  const proposed = await proposeConsolidation(env, config, facts);
  const { ops, dropped } = capDestructiveOps(proposed.ops, facts.length);
  if (ops.length === 0) {
    return { updated: 0, deleted: 0, added: 0, rejected: proposed.rejected + dropped, applied: [] };
  }
  const outcome = await applyConsolidationOps(store, facts, ops);
  outcome.rejected += proposed.rejected + dropped;

  const ctx = getContext();
  recordEvent({
    tenantId: ctx?.auth.principal.tenantId ?? 'default',
    eventType: 'memory_consolidated',
    principalSubject: ctx?.auth.principal.subject ?? '',
    manifestId,
    status: outcome.deleted > 0 || outcome.updated > 0 ? 'changed' : 'unchanged',
    payload: {
      pool_size: facts.length,
      updated: outcome.updated,
      deleted: outcome.deleted,
      added: outcome.added,
      rejected: outcome.rejected,
      over_cap: dropped,
      // What was actually removed or rewritten. This pass DELETES a tenant's
      // memory with no human in the loop, so counts alone would leave an
      // operator unable to tell which facts went — the one question they would
      // have if a pass ever misbehaved.
      operations: outcome.applied.map((a) => ({
        op: a.op,
        ...(a.id ? { id: a.id } : {}),
        ...(a.before ? { before: a.before.slice(0, 300) } : {}),
        ...(a.after ? { after: a.after.slice(0, 300) } : {}),
      })),
    },
  });
  recordCounter('orchestrator_memory_consolidated', {
    manifest_id: manifestId,
    deleted: String(outcome.deleted),
  });
  return outcome;
}
