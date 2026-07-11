import { GitBranchIcon, RotateCcwIcon, SaveIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  activateManifestVersion,
  createManifestVersion,
  getResolvedManifest,
  listManifestVersions,
  listTenantManifests,
  rollbackManifestCanary,
  setManifestCanary,
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
import type { ManifestSummary, ManifestVersionList } from '@/types';

/**
 * Manifest lifecycle workbench — the `/manifests` surface as a slide-over.
 * Tenant-managed manifests are an append-only version log with an active
 * pointer and an optional weighted canary pointer. Here you can import the
 * current agent into the tenant version log, append edited versions, flip the
 * active pointer (rollback), and drive a weighted canary → the `x-manifest-
 * variant` header (the stable/canary badge in the header) reflects the split.
 *
 * Writes need the `manifests:write` scope; local dev (no JWT_VERIFIERS) lets
 * anonymous callers through, so the whole flow is drivable unauthed.
 */
export function ManifestsSheet({
  open,
  onOpenChange,
  manifest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: string;
}) {
  const [rows, setRows] = useState<ManifestSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [importName, setImportName] = useState(manifest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listTenantManifests();
      setRows(r);
      setError(null);
      setSelected((cur) => cur ?? r[0]?.name ?? null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Import any resolvable manifest (e.g. the bundled chat-ui-demo) into the
  // tenant version log as v1 so the lifecycle has something to act on.
  async function importManifest() {
    const name = importName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const resolved = await getResolvedManifest(name);
      await createManifestVersion(name, resolved.manifest, `imported from ${resolved.source}`);
      await refresh();
      setSelected(name);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  const selectedRow = rows.find((r) => r.name === selected) ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-4" /> Manifest lifecycle
          </SheetTitle>
          <SheetDescription>
            Tenant-managed versions, active-pointer rollback, and weighted canary rollout.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {error && <p className="text-xs text-destructive">⚠ {error}</p>}

          <div className="flex flex-wrap items-center gap-1.5">
            {rows.map((r) => (
              <Button
                key={r.name}
                size="sm"
                variant={selected === r.name ? 'secondary' : 'ghost'}
                className="h-7 gap-1 font-mono text-xs"
                onClick={() => setSelected(r.name)}
              >
                {r.name}
                {r.canary_version != null && (r.canary_weight ?? 0) > 0 && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400">◆</span>
                )}
              </Button>
            ))}
            {rows.length === 0 && (
              <span className="text-xs text-muted-foreground">
                No tenant-managed manifests yet — import one below.
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <Input
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="manifest name to import"
              className="h-8 font-mono text-xs"
              onKeyDown={(e) => e.key === 'Enter' && importManifest()}
            />
            <Button
              size="sm"
              className="h-8 whitespace-nowrap"
              disabled={busy || !importName.trim()}
              onClick={importManifest}
            >
              Import as version
            </Button>
          </div>

          {selectedRow ? (
            <VersionsPanel
              key={selectedRow.name}
              summary={selectedRow}
              onChanged={refresh}
              onError={setError}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function VersionsPanel({
  summary,
  onChanged,
  onError,
}: {
  summary: ManifestSummary;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const name = summary.name;
  const [list, setList] = useState<ManifestVersionList | null>(null);
  const [weight, setWeight] = useState(summary.canary_weight ?? 25);
  const [canaryVersion, setCanaryVersion] = useState<number | null>(summary.canary_version ?? null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const refresh = useCallback(async () => {
    try {
      setList(await listManifestVersions(name));
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    }
  }, [name, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  // Seed the JSON editor with the current resolved manifest so a new version is
  // an edit of the live one rather than authored from scratch.
  async function openEditor() {
    try {
      const resolved = await getResolvedManifest(name);
      setEditor(JSON.stringify(resolved.manifest, null, 2));
      setComment('');
    } catch (err) {
      onError(String((err as Error)?.message ?? err));
    }
  }

  async function saveVersion() {
    if (!editor) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor);
    } catch {
      onError('Editor content is not valid JSON.');
      return;
    }
    await act(async () => {
      await createManifestVersion(name, parsed, comment.trim() || 'edited in chat-ui');
      setEditor(null);
    });
  }

  const activeV = list?.active_version ?? summary.active_version;
  const liveCanaryV = summary.canary_version ?? null;
  const liveWeight = summary.canary_weight ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Canary control */}
      <div className="rounded-md border bg-card/40 p-2.5 text-xs">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-medium">Canary</span>
          {liveCanaryV != null && liveWeight > 0 ? (
            <Badge className="py-0 text-[10px]">
              v{liveCanaryV} @ {liveWeight}%
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">none in flight</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={canaryVersion ?? ''}
            onChange={(e) => setCanaryVersion(e.target.value ? Number(e.target.value) : null)}
            className="h-7 rounded-md border bg-transparent px-1.5 text-xs outline-none"
          >
            <option value="">version…</option>
            {list?.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
                {v.version === activeV ? ' (active)' : ''}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={0}
            max={100}
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
            className="flex-1 accent-amber-500"
          />
          <span className="w-9 text-right font-mono">{weight}%</span>
        </div>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            className="h-7 flex-1"
            disabled={busy || canaryVersion == null}
            onClick={() => act(() => setManifestCanary(name, canaryVersion, weight))}
          >
            Apply canary
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            disabled={busy || liveWeight === 0}
            onClick={() => act(() => rollbackManifestCanary(name, false))}
            title="Zero the canary weight (keeps the version pinned)"
          >
            <RotateCcwIcon className="size-3.5" /> Rollback
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={busy || liveCanaryV == null}
            onClick={() => act(() => rollbackManifestCanary(name, true))}
            title="Clear the canary version pointer entirely"
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Version log + editor */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Versions
        </span>
        <Button size="sm" variant="outline" className="ml-auto h-7 gap-1" onClick={openEditor}>
          <SaveIcon className="size-3.5" /> New version
        </Button>
      </div>

      {editor != null && (
        <div className="space-y-1.5 rounded-md border border-dashed p-2">
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="change comment"
            className="h-7 text-xs"
          />
          <textarea
            value={editor}
            onChange={(e) => setEditor(e.target.value)}
            spellCheck={false}
            rows={10}
            className="w-full resize-y rounded-md border bg-transparent p-2 font-mono text-[11px] leading-snug outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 flex-1" disabled={busy} onClick={saveVersion}>
              Save new version
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditor(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1.5 pr-3">
          {list?.versions.map((v) => (
            <div key={v.version} className="rounded-md border bg-background px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">v{v.version}</span>
                {v.version === activeV && (
                  <Badge variant="secondary" className="py-0 text-[10px]">
                    active
                  </Badge>
                )}
                {v.version === liveCanaryV && liveWeight > 0 && (
                  <Badge className="py-0 text-[10px]">canary</Badge>
                )}
                <span
                  className={cn(
                    'truncate text-[10px] text-muted-foreground',
                    !v.comment && 'italic',
                  )}
                >
                  {v.comment || 'no comment'}
                </span>
                {v.version !== activeV && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[10px]"
                    disabled={busy}
                    onClick={() => act(() => activateManifestVersion(name, v.version))}
                    title="Flip the active pointer to this version"
                  >
                    Activate
                  </Button>
                )}
              </div>
            </div>
          ))}
          {list && list.versions.length === 0 && (
            <p className="text-xs text-muted-foreground">No versions.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
