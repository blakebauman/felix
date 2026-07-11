import { Eraser, Palette, PenSquare } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export type SlashCommand = {
  name: string;
  description: string;
  icon: ReactNode;
  action: string;
  shortcut?: string;
};

// Adapted for the chat-ui example. The menu component below is generic; only
// this command list and the actions App wires up are example-specific.
export const slashCommands: SlashCommand[] = [
  {
    name: 'new',
    description: 'Start a new thread',
    icon: <PenSquare className="size-3.5" />,
    action: 'new',
  },
  {
    name: 'clear',
    description: 'Clear this conversation',
    icon: <Eraser className="size-3.5" />,
    action: 'clear',
  },
  {
    name: 'theme',
    description: 'Toggle dark / light mode',
    icon: <Palette className="size-3.5" />,
    action: 'theme',
  },
];

export function SlashCommandMenu({
  query,
  onSelect,
  selectedIndex,
}: {
  query: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  selectedIndex: number;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const filtered = slashCommands.filter((cmd) => cmd.name.startsWith(query.toLowerCase()));

  // biome-ignore lint/correctness/useExhaustiveDependencies(selectedIndex): re-run when the selection moves — the [data-selected] attribute this queries is rendered from selectedIndex
  useEffect(() => {
    const selected = menuRef.current?.querySelector("[data-selected='true']");
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute right-0 bottom-full left-0 z-50 mb-2 overflow-hidden rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-xl"
      ref={menuRef}
    >
      <div className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Commands
      </div>
      <div className="max-h-64 overflow-y-auto pb-1">
        {filtered.map((cmd, index) => (
          <button
            className={cn(
              'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
              index === selectedIndex ? 'bg-muted/70' : 'hover:bg-muted/40',
            )}
            data-selected={index === selectedIndex}
            key={cmd.name}
            onClick={() => onSelect(cmd)}
            onMouseDown={(e) => e.preventDefault()}
            type="button"
          >
            <div className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/70">
              {cmd.icon}
            </div>
            <span className="font-mono text-[13px] text-foreground">/{cmd.name}</span>
            <span className="text-[12px] text-muted-foreground/60">{cmd.description}</span>
            {cmd.shortcut && (
              <span className="ml-auto text-[11px] text-muted-foreground/40">{cmd.shortcut}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
