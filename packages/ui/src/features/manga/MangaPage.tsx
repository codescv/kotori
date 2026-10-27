/** Manga tab: library grid ⇄ reader, routed by `useRouteStore().manga`. */
import { useRouteStore } from '../../app/routes';
import { MangaLibrary } from './MangaLibrary';
import { Reader } from './reader/Reader';
import './manga.css';

export function MangaPage() {
  const view = useRouteStore((s) => s.manga);
  const openManga = useRouteStore((s) => s.openManga);
  if (view.kind === 'reader') {
    return (
      <Reader
        key={view.volumeId}
        volumeId={view.volumeId}
        onExit={() => openManga({ kind: 'library' })}
        onOpenVolume={(volumeId) => openManga({ kind: 'reader', volumeId })}
      />
    );
  }
  return <MangaLibrary onOpen={(volumeId) => openManga({ kind: 'reader', volumeId })} />;
}
