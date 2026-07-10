import {
  BotIcon,
  ClockIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  HistoryIcon,
  PanelRightIcon,
  PlusIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteThreadHistory, getThreadHistory, listManifests, streamChat } from '@/api';
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { AgentSheet } from '@/components/agent/agent-sheet';
import { Conversation } from '@/components/chat/conversation';
import { Greeting } from '@/components/chat/greeting';
import { Message } from '@/components/chat/message';
import { MultimodalInput } from '@/components/chat/multimodal-input';
import type { SlashCommand } from '@/components/chat/slash-commands';
import { ThreadList } from '@/components/chat/thread-list';
import { EvalSheet } from '@/components/eval/eval-sheet';
import { Inspector, type SkillState } from '@/components/inspector/inspector';
import { JobsSheet } from '@/components/jobs/jobs-sheet';
import { ManifestsSheet } from '@/components/manifests/manifests-sheet';
import { ThemeToggle } from '@/components/theme-toggle';
import { useTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  eventsToTurns,
  indexThread,
  listThreads,
  loadTurns,
  migrateLegacy,
  removeThread,
  saveTurns,
  type ThreadMeta,
  titleFromText,
} from '@/lib/threads';
import type { ChatMessage, ImageAttachment, ToolCall, Turn, Variant } from '@/types';

const THREAD_KEY = 'felix.threadId';
const MANIFEST_KEY = 'felix.manifest';

export default function App() {
  const [manifests, setManifests] = useState<string[]>([]);
  const [manifest, setManifest] = useState(() => localStorage.getItem(MANIFEST_KEY) ?? 'chat-ui-demo');
  const [threadId, setThreadId] = useState(() => localStorage.getItem(THREAD_KEY) ?? crypto.randomUUID());
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(localStorage.getItem(THREAD_KEY) ?? ''));
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [variant, setVariant] = useState<Variant | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [evalOpen, setEvalOpen] = useState(false);
  const [manifestsOpen, setManifestsOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [skills, setSkills] = useState<SkillState | null>(null);
  const { resolved, setTheme } = useTheme();

  const abortRef = useRef<AbortController | null>(null);
  // Always-current threadId for async callbacks (avoids stale-closure guards
  // when a server-history response lands after the user switched threads).
  const threadIdRef = useRef(threadId);
  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => localStorage.setItem(THREAD_KEY, threadId), [threadId]);
  useEffect(() => localStorage.setItem(MANIFEST_KEY, manifest), [manifest]);
  // Persist the active transcript blob on every change (cheap; no list churn).
  useEffect(() => saveTurns(threadId, turns), [threadId, turns]);

  useEffect(() => {
    const ctrl = new AbortController();
    listManifests(ctrl.signal)
      .then((names) => names.length && setManifests(names))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Replace the active transcript with the server-checkpointed one when it
  // exists (richer than the local cache: survives across browsers/clears).
  const hydrateFromServer = useCallback((id: string) => {
    getThreadHistory(id)
      .then((h) => {
        if (!h || h.events.length === 0) return;
        const rebuilt = eventsToTurns(h.events);
        if (rebuilt.length) {
          // Only swap into view if the user is still on this thread.
          setTurns((cur) => (id === threadIdRef.current ? rebuilt : cur));
          saveTurns(id, rebuilt);
        }
      })
      .catch(() => {});
  }, []);

  // On mount: migrate legacy storage, load the thread list, and hydrate the
  // active thread from local cache + server. Intentionally runs once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only bootstrap
  useEffect(() => {
    migrateLegacy(Date.now());
    setThreads(listThreads());
    setTurns(loadTurns(threadId));
    hydrateFromServer(threadId);
  }, []);

  const newThread = useCallback(() => {
    abortRef.current?.abort();
    setThreadId(crypto.randomUUID());
    setTurns([]);
    setVariant(null);
    setSkills(null);
    setError(null);
  }, []);

  const selectThread = useCallback(
    (id: string) => {
      if (id === threadId) return;
      abortRef.current?.abort();
      setThreadId(id);
      setTurns(loadTurns(id));
      setVariant(null);
      setSkills(null);
      setError(null);
      hydrateFromServer(id);
    },
    [threadId, hydrateFromServer],
  );

  const deleteThread = useCallback(
    (id: string) => {
      removeThread(id);
      void deleteThreadHistory(id);
      const remaining = listThreads();
      setThreads(remaining);
      if (id === threadId) {
        if (remaining.length) selectThread(remaining[0].id);
        else newThread();
      }
    },
    [threadId, selectThread, newThread],
  );

  // Open one SSE turn: stream model deltas / tool events into the assistant
  // turn identified by `assistantId`. Shared by `send` (new user message) and
  // `regenerate` (replays prior history). Returns the streaming promise.
  const streamInto = useCallback(
    (messagesToSend: ChatMessage[], assistantId: string) => {
      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => prev.map((t) => (t.id === assistantId ? fn(t) : t)));

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStreaming(true);

      return streamChat(
        { manifest, messages: messagesToSend, threadId, signal: ctrl.signal },
        {
          onVariant: setVariant,
          onEvent: (ev) => {
            switch (ev.event) {
              case 'on_chat_model_stream':
                patch((t) => ({ ...t, content: t.content + ev.data.chunk.content }));
                break;
              case 'on_tool_start':
                patch((t) => ({
                  ...t,
                  tools: [...(t.tools ?? []), { name: ev.data.name, input: ev.data.input, done: false }],
                }));
                break;
              case 'on_tool_end':
                patch((t) => ({ ...t, tools: closeTool(t.tools, ev.data.name, ev.data.output) }));
                captureSkills(ev.data.name, ev.data.output, setSkills);
                break;
              case 'on_chain_end': {
                const usage = ev.data.output?.usage;
                if (usage) patch((t) => ({ ...t, usage }));
                break;
              }
              case 'on_error':
                setError(ev.data.message);
                break;
            }
          },
        },
      )
        .catch((err) => {
          if (!ctrl.signal.aborted) setError(String((err as Error)?.message ?? err));
        })
        .finally(() => {
          setStreaming(false);
          abortRef.current = null;
        });
    },
    [manifest, threadId],
  );

  const send = useCallback(
    (text: string, attachments?: ImageAttachment[]) => {
      if (streaming) return;
      const hasAttachments = !!attachments && attachments.length > 0;
      if (!text.trim() && !hasAttachments) return;
      setError(null);
      const userTurn: Turn = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        ...(hasAttachments ? { attachments } : {}),
      };
      const assistantId = crypto.randomUUID();
      const firstTurn = turns.length === 0;
      setTurns((prev) => [...prev, userTurn, { id: assistantId, role: 'assistant', content: '', tools: [] }]);

      // Surface the thread in the sidebar immediately (title from the first
      // user message); refresh the index only at this boundary, not per token.
      const fallbackTitle = titleFromText(text || (hasAttachments ? '📎 Image' : ''));
      indexThread({
        id: threadId,
        manifest,
        title: firstTurn ? fallbackTitle : (threads.find((t) => t.id === threadId)?.title ?? fallbackTitle),
        updatedAt: Date.now(),
      });
      setThreads(listThreads());

      // Steady state: send only the new user message; Felix replays the thread.
      const userMessage: ChatMessage = { role: 'user', content: text };
      if (hasAttachments) userMessage.attachments = attachments;
      void streamInto([userMessage], assistantId);
    },
    [streaming, manifest, threadId, turns, threads, streamInto],
  );

  // Re-run the last assistant turn. Felix's session log is append-only, so a
  // bare re-send would duplicate the prior turn; instead we reset the server
  // log and replay the full transcript up to (and including) the prompting
  // user turn, then stream a fresh answer in place of the old one.
  const regenerate = useCallback(() => {
    if (streaming) return;
    const lastAssistant = turns.length - 1;
    if (lastAssistant < 0 || turns[lastAssistant].role !== 'assistant') return;
    setError(null);

    const replay = turns.slice(0, lastAssistant);
    const messagesToSend: ChatMessage[] = replay
      .filter((t) => t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content }));
    if (messagesToSend.length === 0) return;

    const assistantId = crypto.randomUUID();
    setTurns([...replay, { id: assistantId, role: 'assistant', content: '', tools: [] }]);

    // Reset the server log first so the replayed history isn't double-counted,
    // then stream. Best-effort: an anonymous prod caller can't reset history,
    // but the local transcript stays the source of truth either way.
    void deleteThreadHistory(threadId).then(() => streamInto(messagesToSend, assistantId));
  }, [streaming, turns, threadId, streamInto]);

  // Clear the current conversation in place (keeps the thread id; best-effort
  // server reset). Distinct from "New thread" which mints a fresh id.
  const clearThread = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    setVariant(null);
    setSkills(null);
    setError(null);
    void deleteThreadHistory(threadId);
    saveTurns(threadId, []);
  }, [threadId]);

  // Map a composer submission (text + browser File parts, already converted to
  // data URLs by PromptInput) onto our send(). Image parts become attachments.
  const submit = useCallback(
    (message: PromptInputMessage) => {
      const attachments: ImageAttachment[] = message.files
        .filter((f) => f.mediaType.startsWith('image/'))
        .map((f) => ({ url: f.url, media_type: f.mediaType, filename: f.filename }));
      send(message.text, attachments);
    },
    [send],
  );

  const onSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      switch (cmd.action) {
        case 'new':
          newThread();
          break;
        case 'clear':
          clearThread();
          break;
        case 'theme':
          setTheme(resolved === 'dark' ? 'light' : 'dark');
          break;
      }
    },
    [newThread, clearThread, setTheme, resolved],
  );

  const options = manifests.length ? manifests : [manifest];
  const modelOptions = useMemo(() => options.map((id) => ({ id, label: id })), [options]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <Button
          variant={historyOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-label="Toggle history"
          title="Conversation history"
        >
          <HistoryIcon className="size-4" />
        </Button>
        <span className="font-semibold">Felix chat</span>
        <ThemeToggle />
        <Button
          variant={agentOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8"
          onClick={() => setAgentOpen((o) => !o)}
          aria-label="Agent spec"
          title="Inspect the resolved agent spec"
        >
          <BotIcon className="size-4" />
        </Button>
        {variant && (
          <Badge variant={variant === 'canary' ? 'default' : 'secondary'} className="uppercase">
            {variant}
          </Badge>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground" title={`thread: ${threadId}`}>
          {threadId.slice(0, 8)}
        </span>
        <Button variant="ghost" size="sm" onClick={newThread} disabled={streaming} className="gap-1.5">
          <PlusIcon className="size-4" /> New thread
        </Button>
        <Button
          variant={manifestsOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setManifestsOpen((o) => !o)}
        >
          <GitBranchIcon className="size-4" /> Manifests
        </Button>
        <Button
          variant={jobsOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setJobsOpen((o) => !o)}
        >
          <ClockIcon className="size-4" /> Jobs
        </Button>
        <Button
          variant={evalOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="gap-1.5"
          onClick={() => setEvalOpen((o) => !o)}
        >
          <FlaskConicalIcon className="size-4" /> Eval
        </Button>
        <Button
          variant={inspectorOpen ? 'secondary' : 'ghost'}
          size="icon"
          className="size-8"
          onClick={() => setInspectorOpen((o) => !o)}
          aria-label="Toggle inspector"
        >
          <PanelRightIcon className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {historyOpen && (
          <ThreadList
            threads={threads}
            currentId={threadId}
            disabled={streaming}
            onSelect={selectThread}
            onNew={newThread}
            onDelete={deleteThread}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Conversation>
            {turns.length === 0 && (
              <Greeting manifest={manifest} disabled={streaming} onSend={send} />
            )}
            {turns.map((t, i) => {
              const isLast = i === turns.length - 1;
              return (
                <Message
                  key={t.id}
                  turn={t}
                  streaming={streaming && isLast}
                  onRegenerate={isLast && t.role === 'assistant' ? regenerate : undefined}
                />
              );
            })}
            {error && (
              <div className="mx-auto rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                ⚠ {error}
              </div>
            )}
          </Conversation>
          <div className="border-t pt-3">
            <MultimodalInput
              status={streaming ? 'streaming' : 'ready'}
              isConnected
              onSubmit={submit}
              onStop={() => abortRef.current?.abort()}
              onSlashCommand={onSlashCommand}
              models={modelOptions}
              modelId={manifest}
              onModelChange={setManifest}
            />
          </div>
        </main>
        {inspectorOpen && (
          <Inspector
            open={inspectorOpen}
            onClose={() => setInspectorOpen(false)}
            skills={skills}
            onSuggest={send}
          />
        )}
      </div>
      <EvalSheet open={evalOpen} onOpenChange={setEvalOpen} manifest={manifest} />
      <ManifestsSheet open={manifestsOpen} onOpenChange={setManifestsOpen} manifest={manifest} />
      <JobsSheet
        open={jobsOpen}
        onOpenChange={setJobsOpen}
        manifest={manifest}
        manifestOptions={options}
      />
      <AgentSheet open={agentOpen} onOpenChange={setAgentOpen} manifest={manifest} />
    </div>
  );
}

function closeTool(tools: ToolCall[] | undefined, name: string, output: unknown): ToolCall[] {
  const next = [...(tools ?? [])];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].name === name && !next[i].done) {
      next[i] = { ...next[i], output, done: true };
      break;
    }
  }
  return next;
}

/** Capture a `list_skills` tool result so the Inspector Skills tab can show it. */
function captureSkills(name: string, output: unknown, set: (s: SkillState) => void) {
  if (name !== 'list_skills') return;
  try {
    const obj = typeof output === 'string' ? JSON.parse(output) : output;
    if (obj && Array.isArray(obj.declared) && Array.isArray(obj.active)) {
      set({ declared: obj.declared, active: obj.active });
    }
  } catch {
    // non-JSON list_skills output — ignore
  }
}
