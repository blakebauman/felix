import { ArrowDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Auto-scrolling transcript container. Sticks to the bottom as new tokens
 * stream in, but lets the user scroll up freely; a jump-to-latest button
 * appears when they're not pinned. Built on `use-stick-to-bottom` (the same
 * primitive AI Elements' Conversation uses).
 */
export function Conversation({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <StickToBottom
      className={cn('relative flex-1 overflow-hidden', className)}
      initial="smooth"
      resize="smooth"
    >
      <StickToBottom.Content className="flex flex-col gap-4 p-4">{children}</StickToBottom.Content>
      <ScrollToBottom />
    </StickToBottom>
  );
}

function ScrollToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="absolute bottom-3 left-1/2 size-8 -translate-x-1/2 rounded-full shadow-md"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest"
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
