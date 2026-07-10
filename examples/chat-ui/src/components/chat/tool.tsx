import { CheckCircle2Icon, ChevronDownIcon, LoaderIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ToolCall } from '@/types';

/**
 * Collapsible tool-call card. Unlike AI Elements' Tool (which keys off the AI
 * SDK `ToolUIPart.state`), this is driven by our SSE-derived `ToolCall.done`
 * flag — `on_tool_start` creates it (running), `on_tool_end` completes it.
 */
export function Tool({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-muted/40 text-sm"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 font-mono text-xs">
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{tool.name}</span>
        {tool.done ? (
          <Badge variant="secondary" className="gap-1 py-0">
            <CheckCircle2Icon className="size-3 text-emerald-500" /> done
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1 py-0">
            <LoaderIcon className="size-3 animate-spin" /> running
          </Badge>
        )}
        <ChevronDownIcon
          className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        <Field label="input" value={tool.input} />
        {tool.done && <Field label="output" value={tool.output} emphasis />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Field({ label, value, emphasis }: { label: string; value: unknown; emphasis?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre
        className={cn(
          'overflow-x-auto rounded bg-background p-2 text-xs',
          emphasis ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {render(value)}
      </pre>
    </div>
  );
}

function render(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
