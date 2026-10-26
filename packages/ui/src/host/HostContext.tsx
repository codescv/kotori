/**
 * React context delivering the `PlatformHost` to every component.
 * Owner: coder-3. Components MUST access the host only via `useHost()`.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { PlatformHost } from '@kotori/core';

const HostContext = createContext<PlatformHost | null>(null);

export function HostProvider({ host, children }: { readonly host: PlatformHost; readonly children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): PlatformHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('useHost() called outside <HostProvider>');
  return host;
}
