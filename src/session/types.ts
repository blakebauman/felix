/**
 * Session — the harness's external context object.
 *
 * Inspired by Anthropic's Managed Agents: the session is an append-only
 * event log that lives outside the model's context window. The harness
 * uses `getEvents(...)` to select positional slices and `appendBatch(...)`
 * to commit new events. The pattern loop never holds "the history" — it
 * asks a `SessionStrategy` to render a working-set message array from the
 * session for each model call, so context-management decisions (full
 * replay, windowed, summarized) belong to one swappable strategy instead
 * of being baked into each pattern.
 *
 * Storage shape is a superset of the legacy `StoredMessage`: every event
 * carries a monotonically increasing `seq`, a `kind` discriminator, and
 * the original message fields. Kinds we model today:
 *   - `message` — user / assistant / system turn
 *   - `tool_result` — role='tool' turn (paired with a prior tool_call)
 *   - `tool_call` — reserved for a future split where tool calls become
 *      their own events instead of riding inside an assistant message
 *   - `thinking` — reserved for Anthropic extended-thinking blocks
 *   - `audit` — reserved for cross-cutting events (policy denies, …)
 *
 * `SessionStore.open(threadId)` returns a per-thread handle; empty
 * threadId returns a no-op session, which makes "stateless" callers (the
 * OpenAI-compatible surface without an `x-thread-id` header) automatic.
 */

import type { ModelClient } from '../patterns/model';
import type { ChatMessage, ToolCall } from '../patterns/types';

export type SessionEventKind = 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'audit';

export interface SessionEvent {
  /** Monotonic per-session sequence number, assigned on append. */
  seq: number;
  /** Wall-clock timestamp the event was committed. */
  ts: number;
  kind: SessionEventKind;
  /** Message-shaped fields. Present for `message` / `tool_result`. */
  role?: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /**
   * Free-form metadata. Used by `kind: 'audit'` events to encode their
   * subtype — e.g. `{ type: 'session_summary', covers_to_seq: 42 }` so a
   * later render can find the summary and skip re-summarizing covered
   * events. Storage passes this through verbatim.
   */
  metadata?: Record<string, unknown>;
}

export type AppendableEvent = Omit<SessionEvent, 'seq' | 'ts'> & { ts?: number };

export interface GetEventsOpts {
  /** Inclusive lower bound on `seq`. */
  from?: number;
  /** Exclusive upper bound on `seq`. */
  to?: number;
  /** Cap on number of events returned. Applied after `from`/`to`/`kinds`. */
  limit?: number;
  /** When set, only events whose `kind` is in this set are returned. */
  kinds?: SessionEventKind[];
}

/**
 * Read-only analysis of a session's event log used to decide whether a
 * paused or crashed run can resume — Anthropic's Managed Agents framing
 * of `wake(sessionId)`: "the harness reloads state from the durable
 * session log."
 *
 * Felix's interpretation: a run "paused" when the loop wrote some events
 * (caller turn, model response, tool call, tool result) but didn't reach
 * a clean stop (no final assistant message ending the turn). The next
 * invocation can use this state to skip work the prior run already did.
 */
export interface WakeState {
  /** True when the session has no events yet — nothing to resume. */
  fresh: boolean;
  /** Next sequence number that would be assigned on append. Equivalent
   *  to the number of events. */
  headSeq: number;
  /**
   * Tool calls from the most recent assistant turn that have no matching
   * `tool_result` events after them. Empty when no assistant tool-call
   * cycle is pending. A pending cycle means a prior run either crashed
   * mid-dispatch or never re-entered the loop after the tool results
   * were persisted.
   */
  pendingToolCalls: ToolCall[];
  /**
   * True when the most recent non-audit event is an assistant message
   * without `tool_calls` — the prior run reached an end-of-turn. Callers
   * can stream this final message back without re-invoking the model.
   */
  endedOnAssistant: boolean;
}

export interface Session {
  /** Thread id; empty string indicates a no-op (stateless) session. */
  readonly id: string;
  append(event: AppendableEvent): Promise<void>;
  appendBatch(events: ReadonlyArray<AppendableEvent>): Promise<void>;
  getEvents(opts?: GetEventsOpts): Promise<SessionEvent[]>;
  /** Returns `{ seq: next-seq-to-be-assigned }`. 0 == empty. */
  head(): Promise<{ seq: number }>;
  reset(): Promise<void>;
  /**
   * Analyze the event log and return a `WakeState` describing the resume
   * point. Read-only — does not commit. Callers use this to skip
   * re-doing work the prior run already persisted (a pending tool-call
   * cycle, a completed turn that was never streamed back to the client).
   */
  wake(): Promise<WakeState>;
}

export interface SessionStore {
  open(threadId: string): Session;
}

export interface SessionRenderOpts {
  systemPrompt: string;
  /**
   * Model client for strategies that need to call the model during
   * render — e.g. `SummarizingStrategy` compresses old turns by calling
   * `model.chat(...)` on them. Strategies that don't need a model
   * (full_replay, windowed) ignore this. When a summarizing strategy is
   * configured but no model is supplied, it falls back to windowed
   * behavior instead of failing.
   */
  model?: ModelClient;
}

export interface SessionStrategy {
  /**
   * Turn a session + the incoming caller turns into the working-set
   * message array a pattern hands to the model. Pure function: the
   * strategy may read from the session but does not commit; persistence
   * is the pattern's job via `persistFireAndForget`.
   */
  render(
    session: Session,
    incoming: ChatMessage[],
    opts: SessionRenderOpts,
  ): Promise<ChatMessage[]>;
}

/** Convert a `ChatMessage` into an appendable event. */
export function chatMessageToEvent(m: ChatMessage): AppendableEvent {
  const kind: SessionEventKind = m.role === 'tool' ? 'tool_result' : 'message';
  return {
    kind,
    role: m.role,
    content: m.content,
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  };
}

/**
 * Compute a `WakeState` from a list of events. Pure — doesn't touch a
 * store. Used by `DoSession.wake()` and exposed for tests / callers that
 * already hold an event list (e.g. a synthetic fake session).
 *
 * "Pending tool calls" detection: scan events from highest seq down,
 * find the most recent assistant message that emitted `tool_calls`, and
 * return any of its calls that have no matching `tool_result` event with
 * the same `tool_call_id` in the events that follow it.
 */
export function analyzeWake(events: SessionEvent[]): WakeState {
  const headSeq = events.length;
  // Treat audit events (e.g. session summaries) as bookkeeping — they
  // don't represent caller / model / tool turns and shouldn't gate wake.
  const turns = events.filter((e) => e.kind !== 'audit');
  if (turns.length === 0) {
    return { fresh: true, headSeq, pendingToolCalls: [], endedOnAssistant: false };
  }

  // Find the most recent assistant message that emitted tool_calls.
  let lastAssistantWithCallsIdx = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const e = turns[i]!;
    if (e.role === 'assistant' && e.tool_calls && e.tool_calls.length > 0) {
      lastAssistantWithCallsIdx = i;
      break;
    }
  }

  let pendingToolCalls: ToolCall[] = [];
  if (lastAssistantWithCallsIdx >= 0) {
    const assistant = turns[lastAssistantWithCallsIdx]!;
    const after = turns.slice(lastAssistantWithCallsIdx + 1);
    const resolvedIds = new Set(
      after.filter((e) => e.kind === 'tool_result').map((e) => e.tool_call_id ?? ''),
    );
    pendingToolCalls = (assistant.tool_calls ?? []).filter((tc) => !resolvedIds.has(tc.id));
  }

  const last = turns[turns.length - 1]!;
  const endedOnAssistant =
    last.role === 'assistant' && (!last.tool_calls || last.tool_calls.length === 0);

  return { fresh: false, headSeq, pendingToolCalls, endedOnAssistant };
}

/** Convert a stored event back into a `ChatMessage`. */
export function eventToChatMessage(e: SessionEvent): ChatMessage {
  return {
    role: (e.role ?? 'assistant') as ChatMessage['role'],
    content: e.content ?? '',
    ...(e.tool_call_id ? { tool_call_id: e.tool_call_id } : {}),
    ...(e.name ? { name: e.name } : {}),
    ...(e.tool_calls ? { tool_calls: e.tool_calls } : {}),
  };
}
