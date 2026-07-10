import equal from "fast-deep-equal";
import { ArrowUp, CornerDownLeft, ImagePlus, Loader2, Mic, MicOff, Upload } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  useProviderAttachments,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { cn } from "@/lib/utils";
import { PaperclipIcon, StopIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import { type SlashCommand, SlashCommandMenu, slashCommands } from "./slash-commands";

const MAX_TEXT_LENGTH = 32_000;
const MAX_FILES = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

type Status = "submitted" | "streaming" | "ready" | "error";

export type ModelOption = { id: string; label: string; description?: string };

export type MultimodalInputProps = {
  status: Status;
  isConnected: boolean;
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  onStop?: () => void;
  onSlashCommand?: (command: SlashCommand) => void;
  /** Names of slash commands that won't toast as "not implemented". Default: every name in slashCommands. */
  enabledSlashCommands?: ReadonlySet<string>;
  /** Available manifests for the inline selector. Pass an empty array (default) to hide it. */
  models?: ReadonlyArray<ModelOption>;
  modelId?: string;
  onModelChange?: (modelId: string) => void;
  placeholder?: string;
  className?: string;
};

function PureMultimodalInput(props: MultimodalInputProps) {
  return (
    <PromptInputProvider>
      <MultimodalInputInner {...props} />
    </PromptInputProvider>
  );
}

function MultimodalInputInner({
  status,
  isConnected,
  onSubmit,
  onStop,
  onSlashCommand,
  enabledSlashCommands,
  models,
  modelId,
  onModelChange,
  placeholder = "Ask anything…",
  className,
}: MultimodalInputProps) {
  const controller = usePromptInputController();
  const attachments = useProviderAttachments();
  const text = controller.textInput.value;
  const files = attachments.files;

  // Voice input: live SpeechRecognition. Finalized chunks append to the
  // existing textarea content (with a leading space if needed); interim text
  // is shown as a transient overlay on the mic button itself rather than
  // mutating the textarea, so the user keeps the ability to edit between
  // utterances.
  const appendTranscript = useCallback(
    (final: string) => {
      const cleaned = final.trim();
      if (!cleaned) return;
      const current = controller.textInput.value;
      const sep = current && !/\s$/.test(current) ? " " : "";
      controller.textInput.setInput(current + sep + cleaned);
    },
    [controller.textInput],
  );
  const speech = useSpeechRecognition({ onFinalTranscript: appendTranscript });
  // Surface mic errors as toasts so they're visible from anywhere in the UI.
  useEffect(() => {
    if (speech.error) toast.error(speech.error);
  }, [speech.error]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const hasAutoFocused = useRef(false);

  // Slash command menu state
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const isSlashy = text.startsWith("/") && !text.includes(" ") && !text.includes("\n");
  const slashQuery = isSlashy ? text.slice(1) : "";
  const filteredCommands = useMemo(
    () => (isSlashy ? slashCommands.filter((c) => c.name.startsWith(slashQuery.toLowerCase())) : []),
    [isSlashy, slashQuery],
  );
  const slashOpen = !slashDismissed && isSlashy && filteredCommands.length > 0;

  // Re-enable slash menu after text changes (clears the user's explicit Escape dismissal)
  useEffect(() => {
    setSlashDismissed(false);
  }, []);

  // Clamp selection when filter shrinks
  useEffect(() => {
    if (slashIndex >= filteredCommands.length) setSlashIndex(0);
  }, [slashIndex, filteredCommands.length]);

  // Autofocus once, after first paint
  useEffect(() => {
    if (hasAutoFocused.current) return;
    const t = window.setTimeout(() => {
      textareaRef.current?.focus();
      hasAutoFocused.current = true;
    }, 80);
    return () => window.clearTimeout(t);
  }, []);

  // Re-focus after a successful send (text & files cleared by the provider)
  useEffect(() => {
    if (text === "" && status === "ready") {
      textareaRef.current?.focus({ preventScroll: true });
    }
  }, [text, status]);

  // Drag-and-drop visual feedback (the actual drop is wired by PromptInput itself)
  useEffect(() => {
    const el = formContainerRef.current;
    if (!el) return;
    let depth = 0;

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setIsDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDrop = () => {
      depth = 0;
      setIsDragging(false);
    };
    el.addEventListener("dragenter", onEnter);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onEnter);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const isBusy = status === "streaming" || status === "submitted";
  const trimmedText = text.trim();
  const tooLong = text.length > MAX_TEXT_LENGTH;
  const canSubmit = isConnected && !isBusy && (trimmedText.length > 0 || files.length > 0) && !tooLong;

  const helperText = !isConnected
    ? "Reconnecting…"
    : isBusy
      ? "Generating response…"
      : files.length >= MAX_FILES
        ? `Max ${MAX_FILES} attachments`
        : null;

  const showCharCount = text.length > MAX_TEXT_LENGTH * 0.9;

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      try {
        navigator.vibrate?.(5);
      } catch {
        /* unsupported */
      }
      controller.textInput.clear();
      attachments.clear();
      setSlashIndex(0);
      setSlashDismissed(false);
      if (enabledSlashCommands && !enabledSlashCommands.has(cmd.name)) {
        toast.info(`/${cmd.name} is not implemented yet`);
        return;
      }
      onSlashCommand?.(cmd);
    },
    [controller, attachments, onSlashCommand, enabledSlashCommands],
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      // Intercept slash commands typed in full (e.g., "/new<Enter>")
      const trimmed = message.text.trim();
      if (trimmed.startsWith("/")) {
        const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
        const cmd = slashCommands.find((c) => c.name === name);
        if (cmd) {
          handleSlashSelect(cmd);
          return;
        }
        toast.error(`Unknown command: /${name}`);
        controller.textInput.clear();
        return;
      }

      if (!isConnected) {
        toast.error("Disconnected. Reconnecting…");
        return;
      }
      if (isBusy) {
        toast.error("Wait for the current response to finish.");
        return;
      }
      if (message.text.length > MAX_TEXT_LENGTH) {
        toast.error(`Message exceeds ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
        return;
      }
      if (!message.text.trim() && message.files.length === 0) return;
      await onSubmit(message);
    },
    [isConnected, isBusy, onSubmit, controller, handleSlashSelect],
  );

  const handleTextareaKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!slashOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (filteredCommands.length === 0 ? 0 : (i + 1) % filteredCommands.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) =>
          filteredCommands.length === 0 ? 0 : (i - 1 + filteredCommands.length) % filteredCommands.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // Ignore Shift+Enter — let it insert a newline (and close the menu naturally)
        if (e.key === "Enter" && e.shiftKey) return;
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) handleSlashSelect(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
      }
    },
    [slashOpen, filteredCommands, slashIndex, handleSlashSelect],
  );

  return (
    <div className={cn("relative mx-auto w-full max-w-3xl px-4 pb-4", className)}>
      {!isConnected && <ConnectionBanner />}

      <div ref={formContainerRef} className="relative">
        {slashOpen && (
          <SlashCommandMenu
            query={slashQuery}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            onClose={() => setSlashDismissed(true)}
          />
        )}

        <PromptInput
          accept="image/*"
          multiple
          maxFiles={MAX_FILES}
          maxFileSize={MAX_FILE_SIZE}
          className={cn(
            // Composer surface: resting drop shadow swaps for a slightly
            // stronger focus shadow when the textarea grabs focus.
            "[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/40 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-all [&>div]:duration-200 [&>div]:has-[textarea:focus-visible]:border-foreground/30 [&>div]:has-[textarea:focus-visible]:shadow-[var(--shadow-composer-focus)]",
            "[&_textarea]:focus-visible:ring-0 [&_textarea]:focus-visible:ring-offset-0 [&_textarea]:focus-visible:outline-none",
            isDragging && "[&>div]:border-primary/70 [&>div]:bg-primary/5 [&>div]:ring-2 [&>div]:ring-primary/30",
          )}
          onError={(err) => {
            const messages: Record<typeof err.code, string> = {
              max_files: `Max ${MAX_FILES} attachments`,
              max_file_size: `Max ${(MAX_FILE_SIZE / (1024 * 1024)) | 0}MB per file`,
              accept: "Only image files are supported right now",
            };
            toast.error(messages[err.code] ?? err.message);
          }}
          onSubmit={(message) => handleSubmit(message)}
        >
          <AttachmentsPreview />

          <PromptInputTextarea
            ref={textareaRef}
            className="field-sizing-fixed w-full min-h-24 px-4 pt-3.5 pb-1.5 text-[13px] leading-relaxed placeholder:text-muted-foreground/50"
            placeholder={placeholder}
            maxLength={MAX_TEXT_LENGTH + 200 /* slack so the toast can fire */}
            aria-invalid={tooLong || undefined}
            onKeyDown={handleTextareaKeyDown}
          />

          <PromptInputFooter className="px-3 pb-3">
            <PromptInputTools className="flex items-center gap-2">
              <AttachmentsButton disabled={isBusy} count={files.length} max={MAX_FILES} />
              {speech.isSupported && (
                <MicButton
                  isListening={speech.isListening}
                  interim={speech.interim}
                  onStart={speech.start}
                  onStop={speech.stop}
                  disabled={isBusy}
                />
              )}
              {models && models.length > 0 && (
                <InlinePicker
                  ariaLabel="Choose manifest"
                  options={models}
                  value={modelId}
                  onChange={onModelChange}
                  disabled={isBusy}
                />
              )}
              <HelperHint text={helperText} />
            </PromptInputTools>

            <div className="flex items-center gap-2">
              {showCharCount && (
                <span
                  className={cn(
                    "text-[11px] tabular-nums",
                    tooLong ? "text-destructive" : "text-muted-foreground/60",
                  )}
                  aria-live="polite"
                >
                  {text.length.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}
                </span>
              )}

              <SendOrStop canSubmit={canSubmit} isBusy={isBusy} onStop={onStop} />
            </div>
          </PromptInputFooter>

          {isDragging && <DropOverlay />}
        </PromptInput>
      </div>

      <KeyboardHint />
    </div>
  );
}

function AttachmentsButton({
  disabled,
  count,
  max,
}: {
  disabled: boolean;
  count: number;
  max: number;
}) {
  const attachments = useProviderAttachments();
  const atLimit = count >= max;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        "h-7 w-7 rounded-lg border border-border/40 p-1",
        atLimit && "text-muted-foreground/30",
      )}
      disabled={disabled || atLimit}
      onClick={(e) => {
        e.preventDefault();
        attachments.openFileDialog();
      }}
      aria-label={atLimit ? `Attachment limit reached (${max})` : "Attach images"}
    >
      <PaperclipIcon className="size-3.5" />
    </Button>
  );
}

function HelperHint({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
      {text === "Reconnecting…" && <Loader2 className="size-3 animate-spin" />}
      {text}
    </span>
  );
}

/**
 * Web Speech API toggle. Idle = ghost outline + mic icon. Listening = solid
 * red ring + animated pulse + filled mic + a 1-line interim transcript shown
 * inline beside the button so the user knows their voice is being heard.
 */
function MicButton({
  isListening,
  interim,
  onStart,
  onStop,
  disabled,
}: {
  isListening: boolean;
  interim: string;
  onStart: () => void;
  onStop: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          if (isListening) onStop();
          else onStart();
        }}
        aria-label={isListening ? "Stop voice input" : "Start voice input"}
        title={isListening ? "Stop voice input" : "Voice input"}
        className={cn(
          "relative h-7 w-7 rounded-lg border p-1 transition-colors",
          isListening
            ? "border-red-500/60 bg-red-500/10 text-red-600 dark:text-red-400"
            : "border-border/40",
        )}
      >
        {isListening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
        {isListening && (
          <span className="absolute inset-0 -z-10 animate-pulse rounded-lg bg-red-500/20" aria-hidden />
        )}
      </Button>
      {isListening && interim && (
        <span className="max-w-[20ch] truncate text-[11px] italic text-red-600/80 dark:text-red-400/80">
          {interim}
        </span>
      )}
    </div>
  );
}

function InlinePicker({
  ariaLabel,
  options,
  value,
  onChange,
  disabled,
}: {
  ariaLabel: string;
  options: ReadonlyArray<{ id: string; label: string; description?: string }>;
  value?: string;
  onChange?: (id: string) => void;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <Select value={current?.id} onValueChange={(id) => onChange?.(id)} disabled={disabled || !onChange}>
      <SelectTrigger
        size="sm"
        className="h-7 gap-1.5 rounded-lg border-border/40 bg-transparent px-2 text-[12px] text-muted-foreground hover:text-foreground"
        aria-label={ariaLabel}
      >
        {/* SelectValue's default would render the SelectItem's full children
            (label + description) and bloat the toolbar — force just the label. */}
        <SelectValue>{current?.label ?? ""}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="text-[12px]">
            <span className="flex flex-col">
              <span className="font-medium">{o.label}</span>
              {o.description && <span className="text-[11px] text-muted-foreground">{o.description}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SendOrStop({
  canSubmit,
  isBusy,
  onStop,
}: {
  canSubmit: boolean;
  isBusy: boolean;
  onStop?: () => void;
}) {
  if (isBusy) {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        className="h-7 w-7 rounded-xl shadow-sm transition-transform duration-150 hover:scale-105 active:scale-95"
        onClick={onStop}
        aria-label="Stop generating"
      >
        <StopIcon className="size-3.5" />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      size="icon-sm"
      variant="default"
      className={cn(
        "h-7 w-7 rounded-xl transition-all duration-200",
        canSubmit
          ? "bg-foreground text-background hover:opacity-85 active:scale-95"
          : "cursor-not-allowed bg-muted text-muted-foreground/30 hover:bg-muted",
      )}
      disabled={!canSubmit}
      aria-label="Send message"
    >
      <ArrowUp className="size-4" />
    </Button>
  );
}

function AttachmentsPreview() {
  const attachments = useProviderAttachments();
  const files = attachments.files;
  if (files.length === 0) return null;

  return (
    <div className="flex w-full flex-row gap-2 self-start overflow-x-auto px-3 pt-3">
      {files.map((file) => (
        <PreviewAttachment
          key={file.id}
          attachment={{ url: file.url, name: file.filename, contentType: file.mediaType }}
          onRemove={() => attachments.remove(file.id)}
        />
      ))}
    </div>
  );
}

function ConnectionBanner() {
  return (
    <div className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full border border-border/50 bg-card/80 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
      <Loader2 className="size-3 animate-spin" />
      Reconnecting to the assistant
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-primary/5 backdrop-blur-[2px]">
      <div className="flex items-center gap-2 rounded-full border border-primary/40 bg-card px-3 py-1.5 text-xs font-medium text-primary shadow-sm">
        <ImagePlus className="size-3.5" />
        Drop images to attach
        <Upload className="size-3.5" />
      </div>
    </div>
  );
}

function KeyboardHint() {
  return (
    <div className="mt-1.5 flex justify-center gap-3 text-[10px] text-muted-foreground/50">
      <span className="inline-flex items-center gap-1">
        <Kbd>
          <CornerDownLeft className="size-2.5" />
        </Kbd>
        send
      </span>
      <span className="inline-flex items-center gap-1">
        <Kbd>⇧</Kbd>
        <Kbd>
          <CornerDownLeft className="size-2.5" />
        </Kbd>
        new line
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/50 bg-card px-1 font-sans text-[10px] text-muted-foreground/70">
      {children}
    </kbd>
  );
}

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

export const MultimodalInput = memo(PureMultimodalInput, (prev, next) => {
  if (prev.status !== next.status) return false;
  if (prev.isConnected !== next.isConnected) return false;
  if (prev.placeholder !== next.placeholder) return false;
  if (prev.modelId !== next.modelId) return false;
  if (prev.models !== next.models) return false;
  if (!equal(prev.className, next.className)) return false;
  return true;
});
