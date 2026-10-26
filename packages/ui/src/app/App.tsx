/**
 * Root shell: M3 navigation (rail on wide screens, bottom bar on phones) with the
 * four tabs 🎬 Anime · 📖 Manga · ⬇️ Downloads · ⚙️ Settings. Owner: coder-3.
 */
import { HostProvider } from '../host/HostContext';
import type { PlatformHost } from '@kotori/core';

export function App({ host }: { readonly host: PlatformHost }) {
  return (
    <HostProvider host={host}>
      <main data-kotori-shell>Kotori scaffold — UI not implemented yet ({host.info.platform})</main>
    </HostProvider>
  );
}
