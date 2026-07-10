import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll an async fetcher on an interval while `enabled`. Returns the latest
 * data, an error, a loading flag, and a manual `refresh`. The interval is
 * cleared whenever `enabled` is false, so the Inspector only polls while open.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  { enabled = true, intervalMs = 3000 }: { enabled?: boolean; intervalMs?: number } = {},
): { data: T | undefined; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void run();
    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, run]);

  return { data, error, loading, refresh: run };
}
