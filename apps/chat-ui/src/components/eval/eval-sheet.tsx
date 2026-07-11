import { FlaskConicalIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  addEvalItem,
  createEvalDataset,
  listEvalDatasets,
  listEvalItems,
  listEvalRuns,
  runEvalDataset,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { EvalDataset, EvalDatasetItem, EvalRun } from '@/types';

/**
 * Eval workbench — the `/eval` offline-benchmark surface as a slide-over.
 * Create a golden dataset, append items with a (simplified) rubric, replay the
 * dataset against the currently-selected manifest, and read back per-item
 * pass/fail scores. Tenant-scoped; works anonymously against tenant `default`.
 */
export function EvalSheet({
  open,
  onOpenChange,
  manifest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: string;
}) {
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const refreshDatasets = useCallback(async () => {
    try {
      const ds = await listEvalDatasets();
      setDatasets(ds);
      setError(null);
      setSelected((cur) => cur ?? ds[0]?.name ?? null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (open) void refreshDatasets();
  }, [open, refreshDatasets]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createEvalDataset(name);
      setNewName('');
      await refreshDatasets();
      setSelected(name);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <FlaskConicalIcon className="size-4" /> Eval harness
          </SheetTitle>
          <SheetDescription>
            Golden datasets replayed against a manifest and judged per item. Runs against the active{' '}
            <span className="font-mono">{manifest}</span> agent.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {error && <p className="text-xs text-destructive">⚠ {error}</p>}

          {/* Dataset picker + create */}
          <div className="flex flex-wrap items-center gap-1.5">
            {datasets.map((d) => (
              <Button
                key={d.name}
                size="sm"
                variant={selected === d.name ? 'secondary' : 'ghost'}
                className="h-7 font-mono text-xs"
                onClick={() => setSelected(d.name)}
              >
                {d.name}
              </Button>
            ))}
            {datasets.length === 0 && (
              <span className="text-xs text-muted-foreground">
                No datasets yet — create one below.
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-dataset-name"
              className="h-8 font-mono text-xs"
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <Button
              size="sm"
              className="h-8 gap-1"
              disabled={creating || !newName.trim()}
              onClick={create}
            >
              <PlusIcon className="size-3.5" /> New
            </Button>
          </div>

          {selected ? (
            <DatasetPanel
              key={selected}
              dataset={selected}
              manifest={manifest}
              onError={setError}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DatasetPanel({
  dataset,
  manifest,
  onError,
}: {
  dataset: string;
  manifest: string;
  onError: (msg: string) => void;
}) {
  const [items, setItems] = useState<EvalDatasetItem[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [its, rns] = await Promise.all([listEvalItems(dataset), listEvalRuns(dataset)]);
      setItems(its);
      setRuns(rns);
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    }
  }, [dataset, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run() {
    setRunning(true);
    try {
      await runEvalDataset(dataset, manifest);
      await refresh();
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
        <Button
          size="sm"
          className="ml-auto h-7 gap-1"
          disabled={running || items.length === 0}
          onClick={run}
          title={items.length === 0 ? 'Add an item first' : `Replay against ${manifest}`}
        >
          <PlayIcon className="size-3.5" />
          {running ? 'Running…' : `Run vs ${manifest}`}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 pr-3">
          <AddItemForm dataset={dataset} onAdded={refresh} onError={onError} />

          {items.length > 0 && (
            <section className="space-y-1.5">
              <Heading>Items</Heading>
              {items.map((it) => (
                <div key={it.item_id} className="rounded-md border bg-background p-2 text-xs">
                  <div className="font-medium">{it.user_input}</div>
                  {it.rubric.criteria && (
                    <div className="mt-1 text-muted-foreground">criteria: {it.rubric.criteria}</div>
                  )}
                  {!!it.rubric.must_include?.length && (
                    <div className="mt-0.5 text-muted-foreground">
                      must include: {it.rubric.must_include.join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          {runs.length > 0 && (
            <section className="space-y-2">
              <Heading>Runs</Heading>
              {runs.map((r) => (
                <RunCard key={r.id} run={r} />
              ))}
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function AddItemForm({
  dataset,
  onAdded,
  onError,
}: {
  dataset: string;
  onAdded: () => void;
  onError: (msg: string) => void;
}) {
  const [input, setInput] = useState('');
  const [criteria, setCriteria] = useState('');
  const [mustInclude, setMustInclude] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!input.trim()) return;
    setBusy(true);
    try {
      await addEvalItem(dataset, {
        user_input: input.trim(),
        rubric: {
          criteria: criteria.trim(),
          must_include: mustInclude
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setInput('');
      setCriteria('');
      setMustInclude('');
      onAdded();
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-1.5 rounded-md border border-dashed p-2.5">
      <Heading>Add item</Heading>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="User input, e.g. What is 7 × 6?"
        rows={2}
        className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Input
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
        placeholder="Pass criteria (judge), e.g. answers 42"
        className="h-8 text-xs"
      />
      <Input
        value={mustInclude}
        onChange={(e) => setMustInclude(e.target.value)}
        placeholder="must include (comma-separated), e.g. 42"
        className="h-8 text-xs"
      />
      <Button size="sm" className="h-7 gap-1" disabled={busy || !input.trim()} onClick={add}>
        <PlusIcon className="size-3.5" /> Add
      </Button>
    </section>
  );
}

function RunCard({ run }: { run: EvalRun }) {
  const total = run.pass_count + run.fail_count;
  const rate = total ? Math.round((run.pass_count / total) * 100) : 0;
  return (
    <div className="rounded-md border bg-background p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant={run.fail_count === 0 ? 'default' : 'secondary'} className="py-0">
          {run.pass_count}/{total} pass · {rate}%
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">
          {run.candidate_manifest}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{run.status}</span>
      </div>
      {run.scores.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {run.scores.map((s) => (
            <li key={s.item_id} className="flex items-start gap-2">
              <span
                className={cn(
                  'mt-0.5 font-mono text-[10px] uppercase',
                  s.verdict === 'pass'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-destructive',
                )}
              >
                {s.verdict}
              </span>
              <span className="flex-1 text-muted-foreground" title={s.reasoning}>
                {s.response.slice(0, 80) || s.reasoning.slice(0, 80)}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {s.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
