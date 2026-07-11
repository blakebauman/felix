/**
 * Multi-thread transcript persistence in localStorage, plus reconstruction of
 * a transcript from the server-side ConversationDO event log.
 *
 * Storage layout:
 *   felix.threads          → ThreadMeta[] (the index, newest-first)
 *   felix.turns:<threadId> → Turn[]       (one key per thread)
 *
 * The index is the source of truth for the sidebar; per-thread turn blobs keep
 * large transcripts out of the index read on every render. A one-time migration
 * folds the legacy single-thread keys (felix.turns / felix.threadId) into the
 * new layout so existing sessions don't lose their conversation.
 */

import type { SessionEvent, ToolCall, Turn } from '@/types';

export interface ThreadMeta {
  id: string;
  title: string;
  manifest: string;
  updatedAt: number;
}

const INDEX_KEY = 'felix.threads';
const TURNS_PREFIX = 'felix.turns:';
const LEGACY_TURNS = 'felix.turns';
const LEGACY_THREAD = 'felix.threadId';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function listThreads(): ThreadMeta[] {
  return readJSON<ThreadMeta[]>(INDEX_KEY, []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadTurns(threadId: string): Turn[] {
  return readJSON<Turn[]>(TURNS_PREFIX + threadId, []);
}

/** A short conversation title from arbitrary text (e.g. the first user turn). */
export function titleFromText(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, 48) : 'New conversation';
}

/** Persist a thread's transcript blob (cheap; called per streamed token). */
export function saveTurns(threadId: string, turns: Turn[]): void {
  if (turns.length === 0) return;
  localStorage.setItem(TURNS_PREFIX + threadId, JSON.stringify(turns));
}

/**
 * Upsert a thread's index entry (title + updatedAt). Separate from `saveTurns`
 * so the sidebar list only churns at conversation boundaries, not per token.
 */
export function indexThread(meta: ThreadMeta): void {
  const index = readJSON<ThreadMeta[]>(INDEX_KEY, []).filter((t) => t.id !== meta.id);
  index.push(meta);
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function removeThread(threadId: string): void {
  localStorage.removeItem(TURNS_PREFIX + threadId);
  const index = readJSON<ThreadMeta[]>(INDEX_KEY, []).filter((t) => t.id !== threadId);
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

/**
 * One-time migration of the legacy single-thread keys into the indexed layout.
 * Safe to call on every load — it no-ops once the legacy turns key is gone.
 */
export function migrateLegacy(now: number): void {
  const legacyTurns = readJSON<Turn[]>(LEGACY_TURNS, []);
  if (legacyTurns.length === 0) {
    localStorage.removeItem(LEGACY_TURNS);
    return;
  }
  const id = localStorage.getItem(LEGACY_THREAD) ?? crypto.randomUUID();
  const manifest = localStorage.getItem('felix.manifest') ?? 'chat-ui-demo';
  const firstUser = legacyTurns.find((t) => t.role === 'user');
  saveTurns(id, legacyTurns);
  indexThread({ id, manifest, title: titleFromText(firstUser?.content ?? ''), updatedAt: now });
  localStorage.removeItem(LEGACY_TURNS);
}

/**
 * Rebuild a UI transcript from the ConversationDO event log. Assistant messages
 * that carry only `tool_calls` (no text) are merged into the next assistant
 * message with content, so the result mirrors the live streaming UI (tool cards
 * above the answer) rather than splitting into two bubbles. Tool outputs are
 * matched back to their calls by `tool_call_id`.
 */
export function eventsToTurns(events: SessionEvent[]): Turn[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const turns: Turn[] = [];
  const toolById = new Map<string, ToolCall>();
  let pendingTools: ToolCall[] = [];

  for (const ev of ordered) {
    if (ev.kind === 'tool_result' || ev.role === 'tool') {
      const t = ev.tool_call_id ? toolById.get(ev.tool_call_id) : undefined;
      if (t) {
        t.output = ev.content;
        t.done = true;
      }
      continue;
    }
    if (ev.kind !== 'message') continue;

    if (ev.role === 'user') {
      // Flush any dangling tool-only assistant turn before the next user turn.
      if (pendingTools.length) {
        turns.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          tools: pendingTools,
        });
        pendingTools = [];
      }
      turns.push({ id: crypto.randomUUID(), role: 'user', content: ev.content ?? '' });
      continue;
    }
    if (ev.role === 'assistant') {
      const newTools: ToolCall[] = (ev.tool_calls ?? []).map((tc) => {
        const t: ToolCall = { name: tc.name, input: tc.args, done: false };
        toolById.set(tc.id, t);
        return t;
      });
      const tools = [...pendingTools, ...newTools];
      pendingTools = [];
      const content = ev.content ?? '';
      if (!content && tools.length) {
        // Tool-only step — hold the tools and attach to the next answer.
        pendingTools = tools;
        continue;
      }
      turns.push({ id: crypto.randomUUID(), role: 'assistant', content, tools });
    }
  }
  if (pendingTools.length) {
    turns.push({ id: crypto.randomUUID(), role: 'assistant', content: '', tools: pendingTools });
  }
  return turns;
}
