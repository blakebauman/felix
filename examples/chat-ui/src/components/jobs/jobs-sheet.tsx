import { ClockIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createJob, listJobs, runJob } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { JobRecord } from '@/types';

/**
 * Scheduled-jobs workbench — the `/jobs` registry as a slide-over. A job is a
 * persistent, tenant-scoped record the cron sweep invokes on its cron
 * `schedule` (every ~10 min); an empty schedule means manual-only. "Run now" triggers
 * a job immediately and records a `job_run` audit event (visible in the
 * Inspector Activity feed). Tenant-scoped; works anonymously against `default`.
 */
export function JobsSheet({
  open,
  onOpenChange,
  manifest,
  manifestOptions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: string;
  manifestOptions: string[];
}) {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * *');
  const [manifestId, setManifestId] = useState(manifest);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setJobs(await listJobs());
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [open, refresh]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createJob({ name: name.trim(), schedule: schedule.trim(), manifest_id: manifestId });
      setName('');
      await refresh();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function trigger(jobName: string) {
    setBusy(true);
    try {
      await runJob(jobName);
      await refresh();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <ClockIcon className="size-4" /> Scheduled jobs
          </SheetTitle>
          <SheetDescription>
            Persistent cron-scheduled agent runs. The sweep runs them automatically; "Run now"
            triggers one on demand.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {error && <p className="text-xs text-destructive">⚠ {error}</p>}

          {/* Create form */}
          <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              New job
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="job name, e.g. nightly-digest"
              className="h-8 font-mono text-xs"
            />
            <div className="flex gap-2">
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="cron (m h dom mon dow) — empty = manual"
                className="h-8 font-mono text-xs"
                title="Standard 5-field cron. Empty disables automatic scheduling."
              />
              <select
                value={manifestId}
                onChange={(e) => setManifestId(e.target.value)}
                className="h-8 rounded-md border bg-transparent px-1.5 font-mono text-xs outline-none"
              >
                {(manifestOptions.length ? manifestOptions : [manifest]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" className="h-7 gap-1" disabled={busy || !name.trim()} onClick={create}>
              <PlusIcon className="size-3.5" /> Create
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1.5 pr-3">
              {jobs.length === 0 && (
                <p className="text-xs text-muted-foreground">No jobs yet. Create one above.</p>
              )}
              {jobs.map((j) => (
                <div key={j.name} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{j.name}</span>
                    <Badge variant="secondary" className="py-0 font-mono text-[10px]">
                      {j.schedule || 'manual'}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">{j.manifest_id || '—'}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 gap-1 px-2 text-[10px]"
                      disabled={busy}
                      onClick={() => trigger(j.name)}
                    >
                      <PlayIcon className="size-3" /> Run now
                    </Button>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                    {j.last_status && <span>last: {j.last_status}</span>}
                    {j.last_run_at && <span>ran {rel(j.last_run_at)}</span>}
                    {j.next_run_at && <span>next {rel(j.next_run_at)}</span>}
                    {j.last_error && <span className="text-destructive">{j.last_error}</span>}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Relative time like "in 3h" / "2m ago" from a ms timestamp. */
function rel(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const unit = abs < 3600000 ? `${m}m` : abs < 86400000 ? `${h}h` : `${d}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}
