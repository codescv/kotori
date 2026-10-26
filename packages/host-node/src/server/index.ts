/**
 * @kotori/host-node server library entry (Node 22+ only). Owner: coder-2.
 *
 * Planned layout (see ARCHITECTURE.md §5):
 *   server/main.ts            CLI: parse flags, open data dir, start server, open browser
 *   server/app.ts             `createApp(ctx): Hono` — mounts every route group + static UI
 *   server/context.ts         `ServerContext` { db, settings, explainService, downloads, … }
 *   server/routes/*.ts        settings, anime, manga, ai, downloads, files, media, events
 *   db/sqlite.ts              `node:sqlite` DatabaseSync wrapper + migrations/ (SQL files)
 *   db/repositories/*.ts      series, episodes, tracks, volumes, pages, explanations, threads, downloads
 *   library/anime-scanner.ts  folder → AnimeSeries/AnimeEpisode (+ sidecar subtitle discovery)
 *   library/manga-importer.ts .mokuro / cbz / dir → MangaVolume (+ page root resolution)
 *   media/range-stream.ts     HTTP Range (206) file streaming for <video>
 *   media/ffmpeg.ts           probe streams, extract embedded text subtitle via system ffmpeg
 *   ai/credentials.ts         Vertex ADC / service-account → access token (google-auth-library)
 *   torrent/*                 pure-TS BitTorrent client (see ARCHITECTURE.md §5.4)
 *   downloads/manager.ts      DownloadManager: queue, progress, HostEvent emission, auto-import
 *   settings/store.ts         AppSettings persistence + defaults + migration
 */
export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  /** Serve the prebuilt UI from this directory (undefined in `--dev` where Vite proxies). */
  readonly webDir?: string;
  readonly openBrowser: boolean;
}

export const DEFAULT_PORT = 7865;
