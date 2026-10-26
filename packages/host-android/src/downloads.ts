/**
 * Downloads for Android: Jimaku subtitles, mokuro.moe volumes and generic
 * HTTP files via `fetch` (CapacitorHttp-patched) streamed into
 * `Filesystem.appendFile` in ~1 MiB chunks; auto-import into the libraries.
 *
 * Events: `download-updated` at most once per `downloadEventIntervalMs`
 * (500 ms) per task while bytes flow (trailing update guaranteed), plus
 * immediately on every status change; libraries emit `library-changed`.
 *
 * Torrents — DECISION: there is no BitTorrent engine on Android
 * (`capabilities.torrent = false`). `start({ source.kind: 'torrent' })`
 * hands the magnet (or `.torrent` URL) to an installed BitTorrent app via
 * `openExternal` (Android `ACTION_VIEW` intent) and records the task as
 * `completed` with `progress = 1`, `targetDir = 'external'` ("handed off").
 * Kotori does not track the external app's progress; the user imports the
 * finished folder via the anime library. If no app handles the intent the
 * task is `failed` with the error message. `selectFiles` → `unsupported`.
 *
 * Pause keeps the partial file; resume of single-file tasks sends
 * `Range: bytes=N-` and appends on `206`, else restarts from zero.
 */
import type {
  DownloadFile,
  DownloadKind,
  DownloadRequest,
  DownloadSource,
  DownloadStatus,
  DownloadTask,
  DownloadsApi,
  JimakuFile,
} from '@kotori/core';
import {
  KotoriError,
  buildNyaaRssUrl,
  createJimakuClient,
  parseEpisodeName,
  parseMagnet,
  parseMokuroMoeListing,
  parseNyaaRss,
  resolveMokuroCatalogUrl,
} from './adapters/core';
import { uniqueId, type HostContext } from './context';
import type { AnimeLibrary } from './library/anime';
import type { MangaLibrary } from './library/manga';
import { basename, extname, joinPath, safeFileName, stem } from './paths';
import { extractZip } from './storage/unzip-stream';

const FLUSH_BYTES = 1024 * 1024;
const SUBTITLE_EXT = new Set(['srt', 'ass', 'ssa', 'vtt']);
const TERMINAL: ReadonlySet<DownloadStatus> = new Set(['completed', 'failed', 'cancelled']);

type AbortReason = 'pause' | 'cancel' | 'remove' | 'dispose';
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type TaskPatch = Partial<Mutable<DownloadTask>>;

interface Runtime {
  readonly controller: AbortController;
  reason?: AbortReason;
  done?: Promise<void>;
}

interface WorkerResult {
  readonly importedSeriesId?: string;
  readonly importedVolumeId?: string;
  readonly importedTrackId?: string;
}

export interface DownloadManager extends DownloadsApi {
  /** Load persisted tasks (interrupted ones become `paused`). */
  init(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DownloadLibraries {
  readonly anime: AnimeLibrary;
  readonly manga: MangaLibrary;
}

function kindOf(source: DownloadSource): DownloadKind {
  switch (source.kind) {
    case 'torrent':
      return 'torrent';
    case 'jimaku':
      return 'jimaku-subtitle';
    case 'mokuro-moe':
      return 'mokuro-volume';
    case 'http':
      return 'http-file';
  }
}

function titleOf(request: DownloadRequest): string {
  if (request.title !== undefined && request.title !== '') return request.title;
  const s = request.source;
  switch (s.kind) {
    case 'torrent':
      return s.nyaa?.title ?? s.infoHash;
    case 'jimaku':
      return s.file.name;
    case 'mokuro-moe':
      return s.volume.name;
    case 'http':
      return s.fileName ?? basename(s.url);
  }
}

function isAbortError(error: unknown): boolean {
  return (error instanceof Error && error.name === 'AbortError') || (error instanceof KotoriError && error.code === 'cancelled');
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Strip a single top-level folder shared by every entry (`Vol1/001.jpg` → `001.jpg`). */
function stripCommonRoot(paths: readonly string[]): (path: string) => string {
  const first = paths[0]?.split('/')[0];
  const shared = first !== undefined && paths.length > 0 && paths.every((p) => p.includes('/') && p.split('/')[0] === first);
  return shared && first !== undefined ? (p) => p.slice(first.length + 1) : (p) => p;
}

export function createDownloadManager(ctx: HostContext, libs: DownloadLibraries): DownloadManager {
  const { deps, db, dirs } = ctx;
  const tasks = new Map<string, DownloadTask>();
  const runtimes = new Map<string, Runtime>();
  const resuming = new Set<string>();
  const queue: string[] = [];
  const lastEmit = new Map<string, number>();
  const trailing = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const persist = (task: DownloadTask): void => {
    void db.put('downloads', task).catch((error: unknown) => console.warn('[kotori:downloads] persist failed', error));
  };

  const emitNow = (task: DownloadTask): void => {
    const timer = trailing.get(task.id);
    if (timer !== undefined) clearTimeout(timer);
    trailing.delete(task.id);
    lastEmit.set(task.id, deps.now());
    ctx.emit({ type: 'download-updated', task });
    persist(task);
  };

  /** Coalesced progress publication (≤ 1 event per interval, trailing guaranteed). */
  const emitProgress = (task: DownloadTask): void => {
    const last = lastEmit.get(task.id);
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : deps.now() - last;
    if (elapsed >= deps.downloadEventIntervalMs) {
      emitNow(task);
      return;
    }
    if (trailing.has(task.id)) return;
    trailing.set(
      task.id,
      setTimeout(() => {
        trailing.delete(task.id);
        const latest = tasks.get(task.id);
        if (latest && !disposed) emitNow(latest);
      }, deps.downloadEventIntervalMs - elapsed),
    );
  };

  const requireTask = (taskId: string): DownloadTask => {
    const task = tasks.get(taskId);
    if (!task) throw new KotoriError('not-found', `download not found: ${taskId}`);
    return task;
  };

  /** Apply a patch; status changes are emitted immediately, progress is coalesced. */
  const update = (taskId: string, patch: TaskPatch, drop: readonly (keyof DownloadTask)[] = []): DownloadTask => {
    const old = requireTask(taskId);
    const merged: Mutable<DownloadTask> = { ...old, ...patch, updatedAt: deps.now() };
    for (const key of drop) delete merged[key];
    tasks.set(taskId, merged);
    if (patch.status !== undefined && patch.status !== old.status) emitNow(merged);
    else emitProgress(merged);
    return merged;
  };

  const httpGet = async (url: string, init: RequestInit = {}): Promise<Response> => {
    let response: Response;
    try {
      response = await deps.fetch(url, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new KotoriError('network', `request failed: ${url}`, { cause: error });
    }
    if (!response.ok) throw new KotoriError('network', `HTTP ${response.status} for ${url}`, { details: { status: response.status, url } });
    return response;
  };

  /** Per-run byte accounting → task progress / speed / ETA / files. */
  const tracker = (taskId: string) => {
    const files: DownloadFile[] = [];
    let windowStart = deps.now();
    let windowBytes = 0;
    let speed = 0;
    const publish = (): void => {
      const downloaded = files.reduce((n, f) => n + f.downloadedBytes, 0);
      const total = files.reduce((n, f) => n + f.sizeBytes, 0);
      const elapsed = deps.now() - windowStart;
      if (elapsed >= 1000) {
        speed = Math.round((windowBytes * 1000) / elapsed);
        windowStart = deps.now();
        windowBytes = 0;
      }
      const patch: TaskPatch = { downloadedBytes: downloaded, speedBps: speed, files: files.map((f) => ({ ...f })) };
      if (total > 0) {
        patch.totalBytes = total;
        patch.progress = Math.min(1, downloaded / total);
        if (speed > 0) patch.etaMs = Math.round(((total - downloaded) / speed) * 1000);
      }
      update(taskId, patch);
    };
    return {
      files,
      addFile(path: string): number {
        files.push({ index: files.length, path, sizeBytes: 0, downloadedBytes: 0, selected: true });
        return files.length - 1;
      },
      setSize(index: number, size: number, already: number): void {
        const f = files[index];
        if (f) files[index] = { ...f, sizeBytes: size, downloadedBytes: already };
      },
      onBytes(index: number, delta: number): void {
        const f = files[index];
        if (!f) return;
        files[index] = { ...f, downloadedBytes: f.downloadedBytes + delta, sizeBytes: Math.max(f.sizeBytes, f.downloadedBytes + delta) };
        windowBytes += delta;
        publish();
      },
    };
  };

  type Tracker = ReturnType<typeof tracker>;

  /** Stream `url` into `dest` (native download when available; else append when the server honours `Range`). */
  const fetchToFile = async (url: string, dest: string, signal: AbortSignal, track: Tracker, resume: boolean, headers?: Record<string, string>): Promise<void> => {
    const index = track.addFile(dest);
    const existing = resume ? ((await deps.fs.stat(dest))?.sizeBytes ?? 0) : 0;
    if (deps.downloadToFile && existing === 0) {
      // Native path: bytes go straight to disk (CapacitorHttp would buffer the whole body as base64).
      let last = 0;
      let sized = false;
      await deps.downloadToFile(url, dest, {
        signal,
        ...(headers ? { headers } : {}),
        onProgress: (received, total) => {
          if (total !== undefined && !sized) {
            sized = true;
            track.setSize(index, total, last);
          }
          if (received > last) {
            track.onBytes(index, received - last);
            last = received;
          }
        },
      });
      return;
    }
    const response = await httpGet(url, existing > 0 ? { signal, headers: { ...headers, Range: `bytes=${existing}-` } } : headers ? { signal, headers } : { signal });
    const append = existing > 0 && response.status === 206;
    if (!append) await deps.fs.writeFile(dest, new Uint8Array(0));
    const base = append ? existing : 0;
    const length = Number(response.headers.get('content-length') ?? '0');
    track.setSize(index, length > 0 ? base + length : 0, base);
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await deps.fs.appendFile(dest, bytes);
      track.onBytes(index, bytes.length);
      return;
    }
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    // Abort must also unblock a read that is waiting on the network.
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        pending.push(value);
        pendingBytes += value.length;
        track.onBytes(index, value.length);
        if (pendingBytes >= FLUSH_BYTES) {
          await deps.fs.appendFile(dest, concat(pending, pendingBytes));
          pending = [];
          pendingBytes = 0;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Keep every received byte on disk so a paused task can resume with `Range`.
      if (pendingBytes > 0) await deps.fs.appendFile(dest, concat(pending, pendingBytes));
    }
    if (signal.aborted) throw new KotoriError('cancelled', 'download aborted');
  };

  // --- workers ------------------------------------------------------------------

  /** Attach extracted/downloaded subtitle files to matching episodes. */
  const importSubtitles = async (
    source: Extract<DownloadSource, { kind: 'jimaku' }>,
    paths: readonly string[],
  ): Promise<WorkerResult> => {
    let firstTrack: string | undefined;
    const attach = async (episodeId: string, path: string): Promise<void> => {
      const track = await libs.anime.addTrackFromFile(episodeId, { path, fileName: basename(path), origin: 'jimaku', copy: false });
      firstTrack ??= track.id;
    };
    if (source.episodeId !== undefined) {
      const episode = await libs.anime.getEpisode(source.episodeId);
      const n = episode.parsedName.episode;
      const match = paths.length === 1 ? paths[0] : paths.find((p) => n !== undefined && parseEpisodeName(basename(p)).episode === n);
      if (match !== undefined) await attach(episode.id, match);
    } else if (source.seriesId !== undefined) {
      for (const episode of await libs.anime.listEpisodes(source.seriesId)) {
        const n = episode.parsedName.episode;
        const match = paths.find((p) => n !== undefined && parseEpisodeName(basename(p)).episode === n);
        if (match !== undefined) await attach(episode.id, match);
      }
    }
    return firstTrack === undefined ? {} : { importedTrackId: firstTrack };
  };

  const runJimaku = async (task: DownloadTask, source: Extract<DownloadSource, { kind: 'jimaku' }>, signal: AbortSignal, autoImport: boolean): Promise<WorkerResult> => {
    const file: JimakuFile = source.file;
    const dest = joinPath(task.targetDir, safeFileName(file.name));
    const track = tracker(task.id);
    await fetchToFile(file.url, dest, signal, track, resuming.has(task.id));
    if (!autoImport) return {};
    update(task.id, { status: 'importing' });
    if (file.isTextSubtitle || SUBTITLE_EXT.has(extname(file.name))) return importSubtitles(source, [dest]);
    if (file.archiveFormat === 'zip' || extname(file.name) === 'zip') {
      const folder = joinPath(task.targetDir, safeFileName(stem(file.name)));
      const paths: string[] = [];
      await extractZip(
        () => deps.readFileStream(dest),
        () => deps.fs.readFile(dest),
        (name) => SUBTITLE_EXT.has(extname(name)) && !name.startsWith('__MACOSX/'),
        async (name, data) => {
          const path = joinPath(folder, safeFileName(basename(name)));
          await deps.fs.writeFile(path, data);
          paths.push(path);
        },
      );
      return importSubtitles(source, paths);
    }
    return {}; // rar / 7z: kept on disk, not extractable in-app
  };

  const runMokuro = async (task: DownloadTask, source: Extract<DownloadSource, { kind: 'mokuro-moe' }>, signal: AbortSignal, autoImport: boolean): Promise<WorkerResult> => {
    const name = safeFileName(source.volume.name);
    const mokuroPath = joinPath(task.targetDir, `${name}.mokuro`);
    const imagesDir = joinPath(task.targetDir, name);
    const track = tracker(task.id);
    await fetchToFile(source.volume.mokuroUrl, mokuroPath, signal, track, false);
    if (source.volume.imagesKind === 'archive') {
      const tmp = joinPath(dirs.downloads, `${task.id}.zip`);
      await fetchToFile(source.volume.imagesUrl, tmp, signal, track, resuming.has(task.id));
      // Extract entry-by-entry from a file stream; a shared top folder is stripped afterwards.
      const staging = joinPath(dirs.downloads, `${task.id}.extract`);
      const names: string[] = [];
      await deps.fs.remove(staging);
      await extractZip(
        () => deps.readFileStream(tmp),
        () => deps.fs.readFile(tmp),
        (name) => !name.startsWith('__MACOSX/'),
        async (name, data) => {
          names.push(name);
          await deps.fs.writeFile(joinPath(staging, name), data);
        },
      );
      const strip = stripCommonRoot(names);
      await deps.fs.remove(imagesDir);
      for (const name of names) {
        const from = joinPath(staging, name);
        await deps.fs.writeFile(joinPath(imagesDir, strip(name)), await deps.fs.readFile(from));
        await deps.fs.remove(from);
      }
      await deps.fs.remove(staging);
      await deps.fs.remove(tmp);
    } else {
      const listing = parseMokuroMoeListing(await (await httpGet(source.volume.imagesUrl, { signal })).text(), source.volume.imagesUrl);
      for (const entry of listing.entries.filter((e) => e.kind === 'file')) {
        await fetchToFile(entry.url, joinPath(imagesDir, safeFileName(entry.name)), signal, track, false);
      }
    }
    if (!autoImport) return {};
    update(task.id, { status: 'importing' });
    const volume = await libs.manga.importVolume({ path: mokuroPath });
    return { importedVolumeId: volume.id };
  };

  const runHttp = async (task: DownloadTask, source: Extract<DownloadSource, { kind: 'http' }>, signal: AbortSignal, autoImport: boolean): Promise<WorkerResult> => {
    let fallbackName = 'download';
    try {
      fallbackName = basename(new URL(source.url).pathname) || fallbackName;
    } catch {
      // keep the fallback name
    }
    const dest = joinPath(task.targetDir, safeFileName(source.fileName ?? fallbackName));
    await fetchToFile(source.url, dest, signal, tracker(task.id), resuming.has(task.id));
    const ext = extname(dest);
    if (!autoImport || !['mokuro', 'cbz', 'zip'].includes(ext)) return {};
    update(task.id, { status: 'importing' });
    const volume = await libs.manga.importVolume({ path: dest });
    return { importedVolumeId: volume.id };
  };

  const requests = new Map<string, DownloadRequest>();

  /** Execute one task to completion / pause / cancel / failure. */
  const run = async (taskId: string): Promise<void> => {
    const runtime = runtimes.get(taskId);
    const request = requests.get(taskId);
    if (!runtime || !request) return;
    const { signal } = runtime.controller;
    const task = update(taskId, { status: 'downloading', speedBps: 0 }, ['error']);
    try {
      const source = task.source;
      let result: WorkerResult = {};
      if (source.kind === 'jimaku') result = await runJimaku(task, source, signal, request.autoImport);
      else if (source.kind === 'mokuro-moe') result = await runMokuro(task, source, signal, request.autoImport);
      else if (source.kind === 'http') result = await runHttp(task, source, signal, request.autoImport);
      if (signal.aborted) throw new KotoriError('cancelled', 'download aborted');
      const current = requireTask(taskId);
      update(taskId, { ...result, status: 'completed', progress: 1, speedBps: 0, completedAt: deps.now(), totalBytes: current.totalBytes ?? current.downloadedBytes }, ['etaMs']);
    } catch (error) {
      const reason = runtime.reason;
      if (reason === 'pause' || reason === 'dispose') update(taskId, { status: 'paused', speedBps: 0 }, ['etaMs']);
      else if (reason === 'cancel') {
        await removeOutputs(requireTask(taskId));
        update(taskId, { status: 'cancelled', speedBps: 0 }, ['etaMs']);
      } else if (reason !== 'remove') {
        const wrapped = KotoriError.wrap(error);
        update(taskId, { status: 'failed', speedBps: 0, error: wrapped.message }, ['etaMs']);
      }
    } finally {
      resuming.delete(taskId);
      runtimes.delete(taskId);
      pump();
    }
  };

  /** Start queued tasks up to `maxActiveDownloads`. */
  const pump = (): void => {
    if (disposed) return;
    const max = Math.max(1, ctx.settings.current().downloads.maxActiveDownloads);
    while (runtimes.size < max && queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || !tasks.has(id)) continue;
      const runtime: Runtime = { controller: new AbortController() };
      runtimes.set(id, runtime);
      runtime.done = run(id);
    }
  };

  const removeOutputs = async (task: DownloadTask): Promise<void> => {
    for (const f of task.files ?? []) await deps.fs.remove(f.path).catch(() => undefined);
  };

  const abort = async (taskId: string, reason: AbortReason): Promise<boolean> => {
    const runtime = runtimes.get(taskId);
    if (!runtime) return false;
    runtime.reason = reason;
    runtime.controller.abort();
    await runtime.done;
    return true;
  };

  const handOffTorrent = async (task: DownloadTask, source: Extract<DownloadSource, { kind: 'torrent' }>): Promise<DownloadTask> => {
    const url = source.magnet ?? source.nyaa?.magnet ?? source.torrentUrl ?? `magnet:?xt=urn:btih:${source.infoHash}`;
    try {
      if (url.startsWith('magnet:')) parseMagnet(url);
      await deps.openExternal(url);
      return update(task.id, { status: 'completed', progress: 1, completedAt: deps.now() });
    } catch (error) {
      return update(task.id, { status: 'failed', error: KotoriError.wrap(error).message });
    }
  };

  const settings = () => ctx.settings.current();
  const jimaku = () => {
    const apiKey = settings().anime.jimakuApiKey;
    if (apiKey === '') throw new KotoriError('invalid-argument', 'Jimaku API key is not configured');
    return createJimakuClient({ fetch: deps.fetch, apiKey });
  };

  return {
    async init() {
      const stored = await db.getAll('downloads');
      for (const task of stored) {
        const interrupted = !TERMINAL.has(task.status) && task.status !== 'paused';
        const next: DownloadTask = interrupted ? { ...task, status: 'paused', speedBps: 0 } : task;
        tasks.set(task.id, next);
        requests.set(task.id, { source: task.source, autoImport: true, title: task.title, targetDir: task.targetDir });
        if (interrupted) persist(next);
      }
    },
    async searchNyaa(query) {
      const response = await httpGet(buildNyaaRssUrl(query, settings().downloads.nyaaBaseUrl));
      return parseNyaaRss(await response.text());
    },
    // async so a missing API key rejects instead of throwing synchronously.
    searchJimaku: async (query) => jimaku().searchEntries(query),
    listJimakuFiles: async (entryId, episode) => jimaku().listFiles(entryId, episode),
    async browseMokuroCatalog(url) {
      const target = resolveMokuroCatalogUrl(url ?? settings().downloads.mokuroCatalogUrl);
      const response = await httpGet(target);
      return parseMokuroMoeListing(await response.text(), target);
    },
    async list() {
      return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    async get(taskId) {
      return requireTask(taskId);
    },
    async start(request) {
      const now = deps.now();
      const source = request.source;
      const targetDir =
        request.targetDir ??
        (source.kind === 'torrent'
          ? 'external'
          : source.kind === 'jimaku'
            ? joinPath(dirs.subtitles, 'jimaku', String(source.entry.id))
            : source.kind === 'mokuro-moe'
              ? joinPath(dirs.manga, 'moe')
              : dirs.downloads);
      const task: DownloadTask = {
        id: uniqueId('dl', now),
        kind: kindOf(source),
        source,
        title: titleOf(request),
        status: 'queued',
        progress: 0,
        downloadedBytes: 0,
        speedBps: 0,
        targetDir,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.id, task);
      requests.set(task.id, request);
      emitNow(task);
      if (source.kind === 'torrent') return handOffTorrent(task, source);
      queue.push(task.id);
      pump();
      return requireTask(task.id);
    },
    async pause(taskId) {
      const task = requireTask(taskId);
      if (await abort(taskId, 'pause')) return requireTask(taskId);
      if (task.status === 'queued') {
        queue.splice(queue.indexOf(taskId), 1);
        return update(taskId, { status: 'paused' });
      }
      if (task.status === 'paused') return task;
      throw new KotoriError('invalid-argument', `cannot pause a ${task.status} download`);
    },
    async resume(taskId) {
      const task = requireTask(taskId);
      if (task.status !== 'paused' && task.status !== 'failed') return task;
      if (task.source.kind === 'torrent') return handOffTorrent(task, task.source);
      resuming.add(taskId);
      update(taskId, { status: 'queued' }, ['error']);
      queue.push(taskId);
      pump();
      return requireTask(taskId);
    },
    async cancel(taskId) {
      const task = requireTask(taskId);
      if (await abort(taskId, 'cancel')) return requireTask(taskId);
      if (TERMINAL.has(task.status)) return task;
      const at = queue.indexOf(taskId);
      if (at >= 0) queue.splice(at, 1);
      await removeOutputs(task);
      return update(taskId, { status: 'cancelled', speedBps: 0 });
    },
    async remove(taskId, deleteFiles = false) {
      const task = requireTask(taskId);
      await abort(taskId, 'remove');
      const at = queue.indexOf(taskId);
      if (at >= 0) queue.splice(at, 1);
      const timer = trailing.get(taskId);
      if (timer !== undefined) clearTimeout(timer);
      trailing.delete(taskId);
      tasks.delete(taskId);
      requests.delete(taskId);
      lastEmit.delete(taskId);
      await db.delete('downloads', taskId);
      if (deleteFiles || task.status !== 'completed') await removeOutputs(task);
      ctx.emit({ type: 'download-removed', taskId });
    },
    async selectFiles(taskId) {
      const task = requireTask(taskId);
      if (task.kind === 'torrent') throw new KotoriError('unsupported', 'torrents are handed off to an external app on Android');
      throw new KotoriError('invalid-argument', 'file selection only applies to torrents');
    },
    async dispose() {
      disposed = true;
      await Promise.all([...runtimes.keys()].map((id) => abort(id, 'dispose')));
      for (const timer of trailing.values()) clearTimeout(timer);
      trailing.clear();
      await Promise.all([...tasks.values()].map((t) => db.put('downloads', t).catch(() => undefined)));
    },
  };
}
