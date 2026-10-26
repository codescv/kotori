/**
 * Minimal async-data hook: runs `fn` when `deps` change, exposes
 * `{ data, error, loading, reload }`, and ignores stale resolutions.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  reload(): void;
  /** Locally replace data (optimistic updates / event patches). */
  setData(update: T | ((prev: T | undefined) => T)): void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    fnRef.current().then(
      (value) => {
        if (!alive) return;
        setDataState(value);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((update: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof update === 'function' ? (update as (p: T | undefined) => T)(prev) : update));
  }, []);
  return { data, error, loading, reload, setData };
}
