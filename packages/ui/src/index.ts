/**
 * @kotori/ui public surface. Hosts call `mountKotoriApp(el, host)`; everything
 * else is internal. Owner: coder-3.
 *
 * Planned layout (see ARCHITECTURE.md §6):
 *   app/            App.tsx (shell + tabs), router state (zustand), NavRail/NavBar
 *   theme/          m3-theme.ts (seed → tonal palette → CSS vars), styles.css, useTheme()
 *   host/           HostContext.tsx, mock-host.ts, hooks (useHostEvents, useQuery helpers)
 *   components/m3/  Button, IconButton, Card, Chip, Dialog, Sheet (bottom/side drawer),
 *                   Slider, Switch, TextField, Tabs, Snackbar, Progress, List
 *   components/breakdown/
 *                   AiBreakdownPanel.tsx, RubyText.tsx, ChunkCard.tsx, VocabList.tsx,
 *                   FollowUpThread.tsx, useBreakdownSelection.ts (charIndex ⇄ chunk sync)
 *   features/anime/ AnimeLibrary, SeriesDetail, Player (video + SubtitleOverlay +
 *                   TranscriptPanel + RepeatControls), SubtitleTrackMenu
 *   features/manga/ MangaLibrary, Reader (PageCanvas, BlockOverlay, SpreadLayout, Webtoon),
 *                   BubbleSelectTool (lasso/rect → ocrBubble), PageGuideSheet
 *   features/downloads/ NyaaSearch, JimakuSearch, MokuroCatalogBrowser, DownloadList
 *   features/settings/ AiProviderForm (Gemini API key | Vertex), Appearance, Library, Downloads
 */
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { PlatformHost } from '@kotori/core';
import { App } from './app/App';
import './theme/styles.css';

export { App } from './app/App';
export { HostProvider, useHost } from './host/HostContext';

export interface MountedApp {
  readonly root: Root;
  unmount(): void;
}

export function mountKotoriApp(container: HTMLElement, host: PlatformHost): MountedApp {
  const root = createRoot(container);
  root.render(createElement(App, { host }));
  return {
    root,
    unmount: () => {
      root.unmount();
      void host.dispose();
    },
  };
}
