import { cn } from '@/lib/utils';
import type { Turn } from '@/types';
import { MessageActions } from './message-actions';
import { Response } from './response';
import { Tool } from './tool';

/**
 * One transcript turn. User turns render as a right-aligned bubble; assistant
 * turns render inline tool cards (from `on_tool_start`/`on_tool_end`) followed
 * by streamed markdown. Hovering a turn reveals Copy (and Regenerate on the
 * last assistant turn).
 */
export function Message({
  turn,
  streaming,
  onRegenerate,
}: {
  turn: Turn;
  streaming?: boolean;
  /** Provided only for the last assistant turn (enables Regenerate). */
  onRegenerate?: () => void;
}) {
  if (turn.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        {turn.attachments && turn.attachments.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
            {turn.attachments.map((a) => (
              <img
                key={a.url}
                src={a.url}
                alt={a.filename ?? 'attachment'}
                className="size-24 rounded-xl border border-border/40 object-cover"
              />
            ))}
          </div>
        )}
        {turn.content && (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
            {turn.content}
          </div>
        )}
        <MessageActions content={turn.content} className="pr-1" />
      </div>
    );
  }

  const empty = !turn.content && !turn.tools?.length;
  return (
    <div className="group flex flex-col gap-2">
      {turn.tools?.map((tool, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tool calls are append-only within a turn, never reordered
        <Tool key={`${tool.name}-${i}`} tool={tool} />
      ))}
      {turn.content && (
        <div className={cn('max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2')}>
          <Response>{turn.content}</Response>
        </div>
      )}
      {turn.usage && (
        <div
          className="px-1 font-mono text-[10px] text-muted-foreground"
          title="Cumulative tokens for this turn (all model sub-calls), from the on_chain_end usage payload"
        >
          {turn.usage.input.toLocaleString()} in · {turn.usage.output.toLocaleString()} out ·{' '}
          {(turn.usage.input + turn.usage.output).toLocaleString()} tok
        </div>
      )}
      {empty && streaming && (
        <div className="flex items-center gap-1 px-1 text-muted-foreground">
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current" />
        </div>
      )}
      {!streaming && !empty && (
        <MessageActions content={turn.content} onRegenerate={onRegenerate} className="px-1" />
      )}
    </div>
  );
}
