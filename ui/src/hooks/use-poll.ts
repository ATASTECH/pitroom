import { useCallback, useEffect, useRef, useState } from 'react';

/** Calls `fetcher` now and every `ms` while the tab is visible; keeps the last good data on an error. */
export function usePoll<T>(fetcher: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const ref = useRef(fetcher);
  ref.current = fetcher;
  const run = useCallback(async () => {
    if (document.hidden) return;
    try {
      setData(await ref.current());
      setError(false);
      setTick((t) => t + 1);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void run();
    const id = setInterval(run, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, run, ...deps]);
  return { data, error, tick, reload: run };
}
