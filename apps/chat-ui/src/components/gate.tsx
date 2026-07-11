/**
 * Shared-key gate. Wraps the app: until a valid access key is entered, the
 * chat UI is replaced by a key prompt. The key is checked against the proxy
 * Worker's `CHAT_UI_KEY` secret (via the `x-chat-key` header) by issuing a
 * cheap `GET /api/v1/models` — 200 unlocks, 401 shows an error.
 *
 * Skipped in `vite dev`: there the Vite proxy talks to Felix directly, the
 * proxy Worker (and its secret) isn't in the loop, so there's nothing to gate.
 * That branch lives in main.tsx (so this component's hooks stay unconditional).
 */

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getApiKey, setApiKey, setUnauthorizedHandler } from '@/lib/auth';

type Phase = 'checking' | 'locked' | 'open';

async function keyWorks(): Promise<boolean> {
  try {
    // authHeaders() picks up whatever is currently stored.
    const res = await fetch('/api/v1/models', {
      headers: { ...(getApiKey() ? { 'x-chat-key': getApiKey() as string } : {}) },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function Gate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(getApiKey() ? 'checking' : 'locked');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-lock whenever any API call reports 401 (wrong / rotated key).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setError('That key was rejected. Try again.');
      setPhase('locked');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // On load with a stored key, validate it before showing the app.
  useEffect(() => {
    if (phase !== 'checking') return;
    let alive = true;
    keyWorks().then((ok) => {
      if (alive) setPhase(ok ? 'open' : 'locked');
    });
    return () => {
      alive = false;
    };
  }, [phase]);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const key = value.trim();
      if (!key || submitting) return;
      setSubmitting(true);
      setError(null);
      setApiKey(key);
      const ok = await keyWorks();
      setSubmitting(false);
      if (ok) {
        setValue('');
        setPhase('open');
      } else {
        setError('That key was rejected. Try again.');
      }
    },
    [value, submitting],
  );

  if (phase === 'open') return <>{children}</>;

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="font-semibold">Felix chat</h1>
          <p className="text-sm text-muted-foreground">Enter the access key to continue.</p>
        </div>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access key"
          autoFocus
          aria-invalid={error ? true : undefined}
          disabled={phase === 'checking'}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting || phase === 'checking'}>
          {submitting ? 'Checking…' : phase === 'checking' ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    </div>
  );
}
