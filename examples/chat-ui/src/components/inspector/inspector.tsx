import { XIcon } from 'lucide-react';
import { decideApproval, getToolMetrics, listApprovals, listAudit, listPlans } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePoll } from '@/hooks/usePoll';
import { cn } from '@/lib/utils';
import type { AuditEvent, Plan, PlanStepStatus, ToolMetricsRow } from '@/types';

export interface SkillState {
  declared: string[];
  active: string[];
}

/**
 * Right-hand harness inspector. Surfaces the parity endpoints a chat turn
 * feeds: the audit activity feed, the human-in-the-loop approvals queue,
 * plan/step progress, and the skill set. All read back the `default`-tenant
 * data anonymous chat turns produce; panels poll only while open.
 */
export function Inspector({
  open,
  onClose,
  skills,
  onSuggest,
}: {
  open: boolean;
  onClose: () => void;
  skills: SkillState | null;
  onSuggest: (text: string) => void;
}) {
  return (
    <aside className="flex h-full w-[22rem] flex-col border-l bg-card/40">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">Inspector</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close inspector">
          <XIcon className="size-4" />
        </Button>
      </div>
      <Tabs defaultValue="activity" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full justify-start gap-0 border-b px-1">
          <InspectorTab value="activity">Activity</InspectorTab>
          <InspectorTab value="metrics">Metrics</InspectorTab>
          <InspectorTab value="approvals">Approvals</InspectorTab>
          <InspectorTab value="plans">Plans</InspectorTab>
          <InspectorTab value="skills">Skills</InspectorTab>
        </TabsList>
        <TabsContent value="activity" className="min-h-0 flex-1">
          <ActivityTab enabled={open} />
        </TabsContent>
        <TabsContent value="metrics" className="min-h-0 flex-1">
          <MetricsTab enabled={open} />
        </TabsContent>
        <TabsContent value="approvals" className="min-h-0 flex-1">
          <ApprovalsTab enabled={open} />
        </TabsContent>
        <TabsContent value="plans" className="min-h-0 flex-1">
          <PlansTab enabled={open} />
        </TabsContent>
        <TabsContent value="skills" className="min-h-0 flex-1">
          <SkillsTab skills={skills} onSuggest={onSuggest} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/**
 * Content-sized underline tab: five labels of uneven width can't share a
 * 22rem panel as equal grid columns, so each trigger hugs its label and the
 * active state is the line-variant underline sitting on the list's border.
 */
function InspectorTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger value={value} className="flex-none px-2 text-xs">
      {children}
    </TabsTrigger>
  );
}

// --- Activity ---

const EVENT_TONE: Record<string, string> = {
  tool_call: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  judge_score: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  guardrail_block: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  approval_request: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  approval_decision: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  plan_step: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  model_switch: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
};

function ActivityTab({ enabled }: { enabled: boolean }) {
  const { data, error, loading } = usePoll(() => listAudit({ limit: 60 }), { enabled });
  return (
    <PanelBody loading={loading && !data} error={error} empty={data?.length === 0} emptyText="No activity yet.">
      <div className="space-y-1.5">
        {data?.map((e) => (
          <div key={e.id} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className={cn('py-0 font-mono', EVENT_TONE[e.event_type])}>
                {e.event_type}
              </Badge>
              <span className="text-muted-foreground">{toolOf(e)}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{e.status}</span>
            </div>
            {summary(e) && <div className="mt-1 truncate text-muted-foreground">{summary(e)}</div>}
          </div>
        ))}
      </div>
    </PanelBody>
  );
}

function toolOf(e: AuditEvent): string {
  const t = e.payload?.tool;
  return typeof t === 'string' ? t : e.manifest_id;
}
function summary(e: AuditEvent): string {
  const p = e.payload ?? {};
  if (e.event_type === 'judge_score') return `${p.judge}: score ${p.score} — ${String(p.reasoning ?? '')}`;
  if (e.event_type === 'approval_request' || e.event_type === 'approval_decision')
    return `approval ${String(p.approval_id ?? '').slice(0, 8)}`;
  if (typeof p.output_preview === 'string') return p.output_preview;
  return '';
}

// --- Metrics ---

const HOUR_MS = 60 * 60 * 1000;

/**
 * Tool-call rollups from GET /audit/metrics over the last hour. One row per
 * `(tool, transport, status)`; we fold the per-status rows into a per-tool
 * summary (total calls, error count, slowest avg latency) the way an operator
 * would read the `orchestrator_tool_calls` dataset.
 */
function MetricsTab({ enabled }: { enabled: boolean }) {
  const { data, error, loading } = usePoll(() => getToolMetrics({ sinceMs: HOUR_MS }), { enabled });
  const tools = data ? foldByTool(data.rows) : [];
  return (
    <PanelBody
      loading={loading && !data}
      error={error}
      empty={tools.length === 0}
      emptyText="No tool calls in the last hour. Ask the agent to use a tool (e.g. some arithmetic)."
    >
      <div className="space-y-1.5">
        {tools.map((t) => (
          <div key={t.tool} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="py-0 font-mono">
                {t.tool}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{t.transport}</span>
              <span className="ml-auto font-mono text-muted-foreground">
                {t.count} call{t.count === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className={cn(t.errors > 0 && 'text-destructive')}>
                {t.errors > 0 ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : 'no errors'}
              </span>
              {t.avgMs != null && <span>~{Math.round(t.avgMs)}ms avg</span>}
            </div>
          </div>
        ))}
      </div>
    </PanelBody>
  );
}

interface ToolSummary {
  tool: string;
  transport: string;
  count: number;
  errors: number;
  avgMs: number | null;
}

/** Collapse per-(tool, status) metric rows into one summary per tool. */
function foldByTool(rows: ToolMetricsRow[]): ToolSummary[] {
  const by = new Map<string, ToolSummary>();
  for (const r of rows) {
    const cur =
      by.get(r.tool) ??
      ({ tool: r.tool, transport: r.transport, count: 0, errors: 0, avgMs: null } as ToolSummary);
    cur.count += r.count;
    if (r.status === 'error') cur.errors += r.count;
    if (r.avg_duration_ms != null) cur.avgMs = Math.max(cur.avgMs ?? 0, r.avg_duration_ms);
    by.set(r.tool, cur);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

// --- Approvals ---

function ApprovalsTab({ enabled }: { enabled: boolean }) {
  const { data, error, loading, refresh } = usePoll(() => listApprovals('pending'), { enabled });
  async function decide(id: string, status: 'approved' | 'denied') {
    await decideApproval(id, { status });
    refresh();
  }
  return (
    <PanelBody
      loading={loading && !data}
      error={error}
      empty={data?.length === 0}
      emptyText="No pending approvals. Gated tool calls (e.g. calculator on chat-ui-demo) appear here."
    >
      <div className="space-y-2">
        {data?.map((a) => (
          <div key={a.id} className="rounded-md border bg-background p-2.5 text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="py-0 font-mono">
                {a.tool_name}
              </Badge>
              <span className="text-muted-foreground">{a.manifest_id}</span>
            </div>
            <pre className="my-2 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(a.args, null, 2)}</pre>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 flex-1" onClick={() => decide(a.id, 'approved')}>
                Approve
              </Button>
              <Button size="sm" variant="outline" className="h-7 flex-1" onClick={() => decide(a.id, 'denied')}>
                Deny
              </Button>
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              After deciding, re-send the message — the retry with the same args goes through.
            </p>
          </div>
        ))}
      </div>
    </PanelBody>
  );
}

// --- Plans ---

const STEP_TONE: Record<PlanStepStatus, string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-sky-600 dark:text-sky-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
  skipped: 'text-muted-foreground line-through',
  failed: 'text-destructive',
};

function PlansTab({ enabled }: { enabled: boolean }) {
  const { data, error, loading } = usePoll(() => listPlans(), { enabled });
  return (
    <PanelBody
      loading={loading && !data}
      error={error}
      empty={data?.length === 0}
      emptyText="No plans yet. Switch to the `deep` manifest and ask a multi-step question."
    >
      <div className="space-y-3">
        {data?.map((p: Plan) => (
          <div key={p.id} className="rounded-md border bg-background p-2.5 text-xs">
            <div className="mb-1.5 font-medium">{p.title}</div>
            <ol className="space-y-1">
              {p.steps.map((s) => (
                <li key={s.id} className={cn('flex gap-2', STEP_TONE[s.status])}>
                  <span className="font-mono text-[10px] uppercase">{s.status.replace('_', ' ')}</span>
                  <span className="flex-1">{s.description}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </PanelBody>
  );
}

// --- Skills ---

function SkillsTab({ skills, onSuggest }: { skills: SkillState | null; onSuggest: (text: string) => void }) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3 text-xs">
        <p className="text-muted-foreground">
          Skill activation is model-driven via the <code>list_skills</code> / <code>activate_skill</code> /{' '}
          <code>deactivate_skill</code> tools (per-tenant, restriction-only — no REST surface). Ask the agent to
          manage them.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => onSuggest('List your skills — which are declared and which are active?')}
        >
          Ask the agent to list its skills
        </Button>
        {skills ? (
          <div className="space-y-2">
            <SkillList label="Declared" names={skills.declared} active={skills.active} />
          </div>
        ) : (
          <p className="text-muted-foreground">No <code>list_skills</code> result captured yet this session.</p>
        )}
      </div>
    </ScrollArea>
  );
}

function SkillList({ label, names, active }: { label: string; names: string[]; active: string[] }) {
  if (!names.length) return <p className="text-muted-foreground">{label}: none.</p>;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => (
          <Badge key={n} variant={active.includes(n) ? 'default' : 'secondary'} className="font-mono">
            {n}
            {active.includes(n) ? ' ✓' : ''}
          </Badge>
        ))}
      </div>
    </div>
  );
}

// --- shared ---

function PanelBody({
  loading,
  error,
  empty,
  emptyText,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        {error && <p className="text-xs text-destructive">⚠ {error}</p>}
        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {!loading && empty && <p className="text-xs text-muted-foreground">{emptyText}</p>}
        {!loading && !empty && children}
      </div>
    </ScrollArea>
  );
}
