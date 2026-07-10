import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';

/**
 * Renders streamed assistant markdown. `streamdown` tolerates incomplete
 * markdown mid-stream (unterminated code fences, lists) and highlights code
 * via shiki — the same renderer AI Elements' Response wraps.
 */
export function Response({ children, className }: { children: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        'prose-sm max-w-none break-words [&_pre]:my-2 [&_pre]:overflow-x-auto [&_code]:text-[0.85em]',
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}
