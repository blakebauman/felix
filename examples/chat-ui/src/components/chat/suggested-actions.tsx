import { Button } from '@/components/ui/button';

/**
 * A grid of starter prompts — vercel/ai-chatbot's `SuggestedActions`. Clicking
 * one sends it as the first user turn. The prompts lean into what the bundled
 * `chat-ui-demo` agent surfaces (the approval-gated calculator, skills) so the
 * Inspector panels light up immediately.
 */
const SUGGESTIONS: Array<{ title: string; label: string; prompt: string }> = [
  {
    title: 'What is 7 × 6?',
    label: 'exercises the approval-gated calculator',
    prompt: 'What is 7 × 6?',
  },
  {
    title: 'List your skills',
    label: 'and tell me which are active',
    prompt: 'List your available skills and tell me which ones are active right now.',
  },
  {
    title: 'Explain this harness',
    label: 'sessions, patterns, tool transports',
    prompt:
      'Briefly explain how a managed agents harness virtualizes sessions, patterns, and tools.',
  },
  {
    title: 'Write a haiku',
    label: 'about streaming tokens',
    prompt: 'Write a haiku about streaming tokens from a language model.',
  },
];

export function SuggestedActions({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  return (
    <div className="grid w-full gap-2 sm:grid-cols-2">
      {SUGGESTIONS.map((s, i) => (
        <Button
          key={s.title}
          variant="outline"
          disabled={disabled}
          onClick={() => onSend(s.prompt)}
          style={{ animationDelay: `${i * 60}ms` }}
          className="fade-in-50 slide-in-from-bottom-1 h-auto animate-in flex-col items-start gap-0.5 whitespace-normal rounded-xl px-4 py-3 text-left"
        >
          <span className="font-medium">{s.title}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </Button>
      ))}
    </div>
  );
}
