import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin wrapper over the Web Speech API's SpeechRecognition. Free,
 * browser-native, no API key — but Chromium/Safari only (Firefox doesn't ship
 * it). Feature-detect via the `isSupported` flag returned from the hook.
 *
 * The hook fires `onFinalTranscript(text)` for each finalized utterance so
 * the caller can append to its textarea; it also returns the live `interim`
 * string so the UI can render a ghost preview of what's currently being
 * heard. `start`/`stop` toggle continuous-listening mode — the browser keeps
 * the mic open until `stop()` is called or the user revokes the permission.
 */

type Options = {
  onFinalTranscript: (text: string) => void;
  lang?: string;
};

type SRConstructor = new () => SpeechRecognition;

// SpeechRecognition isn't in lib.dom on all targets; cast through globalThis
// so consumers don't have to add ambient declarations.
function getRecognitionCtor(): SRConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRConstructor;
    webkitSpeechRecognition?: SRConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface SpeechRecognitionResultMinimal {
  transcript: string;
}
interface SpeechRecognitionResultListMinimal {
  isFinal: boolean;
  [0]: SpeechRecognitionResultMinimal;
}
interface SpeechRecognitionEventMinimal {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultListMinimal>;
}

interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventMinimal) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function useSpeechRecognition({ onFinalTranscript, lang = "en-US" }: Options) {
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const isSupported = getRecognitionCtor() !== null;

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const start = useCallback(() => {
    setError(null);
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("Voice input isn't supported in this browser.");
      return;
    }
    if (recognitionRef.current) return; // already running

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onresult = (event) => {
      let final = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (!r) continue;
        if (r.isFinal) final += r[0].transcript;
        else interimChunk += r[0].transcript;
      }
      if (final) onFinalTranscript(final);
      setInterim(interimChunk);
    };

    rec.onerror = (e) => {
      // Some errors are benign ("no-speech" when nothing is heard) — surface
      // the rest. "not-allowed" means the mic permission was denied.
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(humanizeError(e.error));
    };

    rec.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
      setInterim("");
    };

    try {
      rec.start();
      recognitionRef.current = rec;
      setIsListening(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start microphone.");
    }
  }, [lang, onFinalTranscript]);

  // Stop on unmount so we don't leak the mic.
  useEffect(() => () => stop(), [stop]);

  return { isSupported, isListening, interim, error, start, stop };
}

function humanizeError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access denied. Enable it in your browser's site settings.";
    case "audio-capture":
      return "No microphone detected.";
    case "network":
      return "Voice recognition needs an internet connection.";
    default:
      return `Voice input error: ${code}`;
  }
}
