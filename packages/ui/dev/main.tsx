/**
 * Dev harness entry: mounts the app against the MockPlatformHost. Owner: coder-3.
 *
 * Optional query params for quick visual checks / screenshots:
 *   ?tab=anime|manga|downloads|settings
 *   ?episode=series-kotori-ep1            open the player
 *   ?volume=vol-houkago-1                 open the manga reader
 *   ?explain=食べてんじゃねぇよ！&focus=3   open a breakdown on a sentence
 *   ?theme=dark|light  ?latency=0
 */
import { useRouteStore, type Tab } from '../src/app/routes';
import { mountKotoriApp } from '../src/index';
import { createMockPlatformHost } from '../src/host/mock-host';
import { useBreakdownStore } from '../src/stores/breakdown';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme');
const latency = params.get('latency');
const host = createMockPlatformHost({
  ...(latency !== null ? { latencyMs: Number(latency) } : {}),
  ...(theme === 'dark' || theme === 'light' ? { settings: { ui: { theme } } } : {}),
});

const routes = useRouteStore.getState();
const tab = params.get('tab');
if (tab) routes.setTab(tab as Tab);
const episode = params.get('episode');
if (episode) routes.openAnime({ kind: 'player', seriesId: episode.replace(/-ep\d+$/, ''), episodeId: episode });
const volume = params.get('volume');
if (volume) routes.openManga({ kind: 'reader', volumeId: volume });

const root = document.getElementById('root');
if (root) mountKotoriApp(root, host);

const explain = params.get('explain');
if (explain) {
  const focus = Number(params.get('focus') ?? '0');
  void useBreakdownStore.getState().open(host, { sentence: explain, source: { kind: 'manual' }, focusCharIndex: focus });
}
