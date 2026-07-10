import { SuggestedActions } from './suggested-actions';

/**
 * Empty-conversation overview — the analogue of vercel/ai-chatbot's `Greeting`
 * (the welcome heading) plus `SuggestedActions` (the clickable prompt grid).
 * Shown until the first turn lands.
 */
export function Greeting({
  manifest,
  disabled,
  onSend,
}: {
  manifest: string;
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-2 pt-12 md:pt-20">
      <div className="flex flex-col gap-1.5">
        <h2 className="fade-in-50 slide-in-from-bottom-2 animate-in text-2xl font-semibold duration-500">
          Hello there!
        </h2>
        <p className="fade-in-50 slide-in-from-bottom-2 animate-in text-2xl text-muted-foreground duration-700">
          Ask the <span className="font-mono text-xl">{manifest}</span> agent anything.
        </p>
      </div>
      <SuggestedActions disabled={disabled} onSend={onSend} />
    </div>
  );
}
