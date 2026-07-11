import { BotIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getAgentCard, getResolvedManifest } from '@/api';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { AgentCard, ResolvedManifest } from '@/types';

/**
 * Agent spec panel — "what is this agent". Shows the resolved manifest spec for
 * the *selected* agent (pattern, model, tools, skills, memory, governance) and,
 * below it, the orchestrator's A2A discovery card (the peer-facing document for
 * the default manifest). Read-only; reflects what the harness compiled.
 */
export function AgentSheet({
  open,
  onOpenChange,
  manifest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: string;
}) {
  const [resolved, setResolved] = useState<ResolvedManifest | null>(null);
  const [card, setCard] = useState<AgentCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResolved(null);
    setError(null);
    let live = true;
    getResolvedManifest(manifest)
      .then((r) => live && setResolved(r))
      .catch((e) => live && setError(String((e as Error)?.message ?? e)));
    getAgentCard()
      .then((c) => live && setCard(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, manifest]);

  const spec = (resolved?.manifest as ManifestLike | undefined)?.spec;
  const meta = (resolved?.manifest as ManifestLike | undefined)?.metadata;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <BotIcon className="size-4" /> Agent spec
            <span className="font-mono text-xs text-muted-foreground">{manifest}</span>
          </SheetTitle>
          <SheetDescription>
            The resolved manifest the harness compiled for the selected agent.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4 text-xs">
            {error && <p className="text-destructive">⚠ {error}</p>}
            {!resolved && !error && <p className="text-muted-foreground">Loading…</p>}

            {resolved && spec && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="font-mono">
                    {resolved.source}
                    {resolved.version != null ? ` v${resolved.version}` : ''}
                  </Badge>
                  {meta?.version && (
                    <span className="text-muted-foreground">spec {meta.version}</span>
                  )}
                </div>
                {meta?.description && <p className="text-muted-foreground">{meta.description}</p>}

                <Section title="Loop">
                  <Row label="pattern" value={spec.pattern} />
                  <Row label="execution" value={spec.execution?.mode ?? 'transient'} />
                  <Row label="session" value={spec.session?.strategy ?? 'full_replay'} />
                </Section>

                <Section title="Model">
                  <Row label="id" value={modelField(spec.model, 'id')} />
                  <Row label="temperature" value={modelField(spec.model, 'temperature')} />
                  <Row label="max_tokens" value={modelField(spec.model, 'max_tokens')} />
                  {asArray(spec.model?.fallbacks).length > 0 && (
                    <Chips label="fallbacks" items={asArray(spec.model?.fallbacks).map(String)} />
                  )}
                  {spec.model?.cache ? <Row label="cache" value="on" /> : null}
                  {spec.model?.thinking_budget ? (
                    <Row label="thinking" value={`${String(spec.model.thinking_budget)} tok`} />
                  ) : null}
                </Section>

                <Section title="Tools & skills">
                  <Chips label="tools" items={asArray(spec.tools).map(String)} />
                  <Chips
                    label="skills"
                    items={asArray(spec.skills).map(
                      (s) => (s as { name?: string })?.name ?? String(s),
                    )}
                  />
                </Section>

                <Section title="Memory">
                  <Row label="checkpointer" value={spec.memory?.checkpointer ?? 'none'} />
                  <Row label="store" value={spec.memory?.store ?? 'none'} />
                </Section>

                {(asArray(spec.guardrails?.judges).length > 0 ||
                  asArray(spec.approvals).length > 0 ||
                  asArray(spec.policies).length > 0 ||
                  spec.limits) && (
                  <Section title="Governance">
                    {asArray(spec.guardrails?.judges).map((j, i) => {
                      const judge = j as { name?: string; threshold?: number };
                      return (
                        <Row
                          // biome-ignore lint/suspicious/noArrayIndexKey: static read-only manifest list, never reordered
                          key={`judge-${i}`}
                          label={`judge: ${judge.name ?? i}`}
                          value={`≥ ${judge.threshold ?? '—'}`}
                        />
                      );
                    })}
                    {asArray(spec.approvals).map((a, i) => {
                      const ap = a as { id?: string; tools?: string[] };
                      return (
                        <Row
                          // biome-ignore lint/suspicious/noArrayIndexKey: static read-only manifest list, never reordered
                          key={`appr-${i}`}
                          label={`approval: ${ap.id ?? i}`}
                          value={asArray(ap.tools).join(', ')}
                        />
                      );
                    })}
                    {asArray(spec.policies).map((p, i) => {
                      const pol = p as { id?: string };
                      // biome-ignore lint/suspicious/noArrayIndexKey: static read-only manifest list, never reordered
                      return <Row key={`pol-${i}`} label="policy" value={pol.id ?? String(i)} />;
                    })}
                    {spec.limits &&
                      Object.entries(spec.limits).map(([k, v]) => (
                        <Row key={`lim-${k}`} label={k} value={String(v)} />
                      ))}
                  </Section>
                )}

                <Section title="Connectivity">
                  <Row label="mcp servers" value={asArray(spec.mcp_servers).length || '—'} />
                  <Row label="a2a peers" value={asArray(spec.a2a?.peers).length || '—'} />
                  <Row label="containers" value={asArray(spec.containers).length || '—'} />
                  <Row label="queues" value={asArray(spec.queues).length || '—'} />
                  <Row label="sandboxes" value={asArray(spec.sandboxes).length || '—'} />
                  <Row label="browser tools" value={asArray(spec.browser_tools).length || '—'} />
                </Section>

                <Section title="Inbound auth">
                  <Row
                    label="anonymous"
                    value={spec.auth?.inbound?.allow_anonymous ? 'allowed' : 'denied'}
                  />
                  {asArray(spec.auth?.inbound?.required_scopes).length > 0 && (
                    <Chips
                      label="scopes"
                      items={asArray(spec.auth?.inbound?.required_scopes).map(String)}
                    />
                  )}
                </Section>
              </>
            )}

            {card && (
              <Section title="A2A discovery card (default agent)">
                <Row label="name" value={card.name} />
                <Chips label="protocols" items={card.protocols} />
                {Object.entries(card.endpoints).map(([k, v]) => (
                  <Row key={`ep-${k}`} label={k} value={v} />
                ))}
                {card.capabilities.length > 0 && (
                  <Chips label="capabilities" items={card.capabilities.map((c) => c.id)} />
                )}
                {card.federation && (
                  <Row label="federation" value={`bundle v${card.federation.bundleVersion}`} />
                )}
              </Section>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

// --- helpers ---

interface ManifestLike {
  metadata?: { name?: string; version?: string; description?: string };
  spec?: {
    pattern?: string;
    model?: Record<string, unknown>;
    tools?: unknown[];
    skills?: unknown[];
    memory?: { checkpointer?: string; store?: string };
    session?: { strategy?: string };
    guardrails?: { judges?: unknown[]; providers?: string[] };
    approvals?: unknown[];
    policies?: unknown[];
    limits?: Record<string, unknown>;
    auth?: {
      inbound?: { allow_anonymous?: boolean; required_scopes?: string[]; schemes?: string[] };
    };
    execution?: { mode?: string };
    mcp_servers?: unknown[];
    a2a?: { peers?: unknown[] };
    containers?: unknown[];
    queues?: unknown[];
    sandboxes?: unknown[];
    browser_tools?: unknown[];
  };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function modelField(
  model: Record<string, unknown> | undefined,
  key: string,
): string | number | undefined {
  const v = model?.[key];
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 rounded-md border bg-card/40 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number | undefined }) {
  if (value === undefined || value === '' || value === '—') {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-muted-foreground/50">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-right font-mono">{value}</span>
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex flex-wrap justify-end gap-1">
        {items.length === 0 ? (
          <span className="font-mono text-muted-foreground/50">—</span>
        ) : (
          items.map((it) => (
            <Badge key={it} variant="secondary" className="py-0 font-mono text-[10px]">
              {it}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}
