/**
 * `DownloadManager` (ARCHITECTURE.md §5.5): persistent task queue with
 * `maxActiveDownloads` concurrency and one worker per source kind:
 *
 *  - `torrent`    → pure-TS `TorrentClient` (lazy singleton)
 *  - `jimaku`     → fetch to the subtitle store, `.zip` packs unpacked with fflate,
 *                   files matched to episodes by `parseEpisodeName`
 *  - `mokuro-moe` → `.mokuro` + images archive (or image dir) to `manga/{name}/`
 *  - `http`       → generic streamed download with HTTP Range resume
 *
 * Progress becomes `download-updated` events (coalesced to ≤ 1 per 500 ms per
 * task, immediate on status change); auto-import emits `library-changed`.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { KotoriError } from '@kotori/core';
import type {
  AnimeEpisode,
  AppSettings,
  DownloadFile,
  DownloadKind,
  DownloadRequest,
  DownloadSource,
  DownloadStatus,
  DownloadTask,
  HostEvent,
  Id,
} from '@kotori/core';
import { parseEpisodeName, parseMagnet, parseMokuroMoeListing } from '@kotori/core';
import type { DownloadRepository } from '../db/repositories';
import { sanitizeFileName } from '../library/subtitle-store';
import type { TorrentEngine, TorrentHandle } from './torrent-engine';

export const PROGRESS_INTERVAL_MS = 500;

/** Library hooks used for auto-import (implemented by the server services). */
export interface DownloadImportHooks {
  importAnime(path: string): Promise<{ seriesId: Id }>;
  importManga(path: string): Promise<{ volumeId: Id }>;
  attachSubtitle(episodeId: Id, filePath: string, fileName: string): Promise<{ trackId: Id }>;
  listEpisodes(seriesId: Id): Promise<readonly AnimeEpisode[]>;
}

export interface DownloadManagerDeps {
  readonly repo: DownloadRepository;
  readonly settings: () => AppSettings;
  readonly emit: (event: HostEvent) => void;
  readonly dataDir: string;
  readonly hooks: DownloadImportHooks;
  readonly fetch?: typeof fetch;
  /** Lazily creates the torrent engine on first use. */
  readonly torrentEngine?: () => TorrentEngine;
  readonly now?: () => number;
}

const ACTIVE: ReadonlySet<DownloadStatus> = new Set(['resolving', 'downloading', 'importing']);
const FINISHED: ReadonlySet<DownloadStatus> = new Set(['completed', 'failed', 'cancelled']);

const KIND_BY_SOURCE: Readonly<Record<DownloadSource['kind'], DownloadKind>> = {
  torrent: 'torrent',
  jimaku: 'jimaku-subtitle',
  'mokuro-moe': 'mokuro-volume',
  http: 'http-file',
};

const TEXT_SUB = /\.(ass|ssa|srt|vtt)$/i;

interface Running {
  readonly controller: AbortController;
  /** Torrent tasks keep their engine handle + listeners. */
  torrent?: { handle: TorrentHandle; detach: () => void };
}

function randomId(): Id {
  return `dl_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function defaultTitle(source: DownloadSource): string {
  switch (source.kind) {
    case 'torrent': {
      if (source.nyaa) return source.nyaa.title;
      if (source.magnet) {
        try {
          return parseMagnet(source.magnet).name ?? source.infoHash;
        } catch {
          return source.infoHash;
        }
      }
      return source.infoHash;
    }
    case 'jimaku':
      return source.file.name;
    case 'mokuro-moe':
      return source.volume.name;
    case 'http': {
      if (source.fileName) return source.fileName;
      const url = new URL(source.url);
      return decodeURIComponent(basename(url.pathname)) || url.hostname || 'download';
    }
  }
}

export class DownloadManager {
  private readonly tasks = new Map<Id, DownloadTask>();
  private readonly running = new Map<Id, Running>();
  private readonly lastEmit = new Map<Id, number>();
  private readonly pendingEmit = new Map<Id, ReturnType<typeof setTimeout>>();
  private engine: TorrentEngine | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly deps: DownloadManagerDeps) {
    this.fetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? Date.now;
  }

  /** Load persisted tasks; interrupted ones are re-queued. */
  init(): void {
    for (const task of this.deps.repo.list()) {
      const restored = ACTIVE.has(task.status) ? { ...task, status: 'queued' as const, speedBps: 0 } : task;
      this.tasks.set(task.id, restored);
      this.autoImport.set(task.id, this.deps.repo.autoImport(task.id));
    }
    this.pump();
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(taskId: Id): DownloadTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new KotoriError('not-found', `Download ${taskId} not found`);
    return task;
  }

  async start(request: DownloadRequest): Promise<DownloadTask> {
    this.validate(request);
    const now = this.now();
    const task: DownloadTask = {
      id: randomId(),
      kind: KIND_BY_SOURCE[request.source.kind],
      source: request.source,
      title: request.title ?? defaultTitle(request.source),
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      speedBps: 0,
      targetDir: request.targetDir ?? this.defaultTargetDir(request.source),
      createdAt: now,
      updatedAt: now,
      ...(request.source.kind === 'jimaku' && request.source.file.sizeBytes !== undefined ? { totalBytes: request.source.file.sizeBytes } : {}),
      ...(request.source.kind === 'mokuro-moe' && request.source.volume.sizeBytes !== undefined ? { totalBytes: request.source.volume.sizeBytes } : {}),
    };
    this.autoImport.set(task.id, request.autoImport);
    this.commit(task, true);
    this.pump();
    return this.get(task.id);
  }

  async pause(taskId: Id): Promise<DownloadTask> {
    const task = this.get(taskId);
    if (FINISHED.has(task.status) || task.status === 'paused') return task;
    const run = this.running.get(taskId);
    if (run?.torrent) {
      run.torrent.handle.pause();
      this.commit({ ...task, status: 'paused', speedBps: 0 }, true);
    } else {
      this.commit({ ...task, status: 'paused', speedBps: 0 }, true);
      run?.controller.abort();
      this.running.delete(taskId);
    }
    this.pump();
    return this.get(taskId);
  }

  async resume(taskId: Id): Promise<DownloadTask> {
    const task = this.get(taskId);
    if (task.status !== 'paused' && task.status !== 'failed') return task;
    const run = this.running.get(taskId);
    if (run?.torrent) {
      run.torrent.handle.resume();
      this.commit({ ...task, status: 'downloading' }, true);
    } else {
      const { error: _e, ...rest } = task;
      this.commit({ ...rest, status: 'queued' }, true);
      this.pump();
    }
    return this.get(taskId);
  }

  async cancel(taskId: Id): Promise<DownloadTask> {
    const task = this.get(taskId);
    if (FINISHED.has(task.status)) return task;
    await this.stopWorker(taskId, false);
    this.commit({ ...task, status: 'cancelled', speedBps: 0 }, true);
    this.pump();
    return this.get(taskId);
  }

  async remove(taskId: Id, deleteFiles = false): Promise<void> {
    const task = this.get(taskId);
    await this.stopWorker(taskId, deleteFiles);
    // Seeding torrents outlive their worker; drop them from the engine too.
    if (task.source.kind === 'torrent' && this.engine?.get(task.source.infoHash.toLowerCase())) {
      await this.engine.remove(task.source.infoHash.toLowerCase(), { deleteFiles });
    }
    if (deleteFiles) await this.deleteTaskFiles(task);
    this.tasks.delete(taskId);
    this.autoImport.delete(taskId);
    this.deps.repo.remove(taskId);
    const timer = this.pendingEmit.get(taskId);
    if (timer) clearTimeout(timer);
    this.pendingEmit.delete(taskId);
    this.deps.emit({ type: 'download-removed', taskId });
    this.pump();
  }

  async selectFiles(taskId: Id, fileIndexes: readonly number[]): Promise<DownloadTask> {
    const task = this.get(taskId);
    if (task.kind !== 'torrent') throw new KotoriError('invalid-argument', 'Only torrent downloads have selectable files');
    const run = this.running.get(taskId);
    const source = task.source.kind === 'torrent' ? { ...task.source, fileIndexes: [...fileIndexes] } : task.source;
    if (run?.torrent) run.torrent.handle.selectFiles(fileIndexes);
    const files = task.files?.map((f) => ({ ...f, selected: fileIndexes.includes(f.index) }));
    this.commit({ ...task, source, ...(files ? { files } : {}) }, true);
    return this.get(taskId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.pendingEmit.values()) clearTimeout(timer);
    this.pendingEmit.clear();
    for (const [id, run] of this.running) {
      run.controller.abort();
      run.torrent?.detach();
      const task = this.tasks.get(id);
      if (task) this.deps.repo.put({ ...task, updatedAt: this.now() });
    }
    this.running.clear();
    await this.engine?.destroy();
    this.engine = undefined;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private readonly autoImport = new Map<Id, boolean>();

  private validate(request: DownloadRequest): void {
    const s = request.source;
    if (s.kind === 'torrent') {
      if (!s.magnet && !s.torrentUrl && !/^[0-9a-f]{40}$/i.test(s.infoHash)) throw new KotoriError('invalid-argument', 'Torrent source needs a magnet, torrent URL or info hash');
      if (!this.deps.torrentEngine) throw new KotoriError('unsupported', 'BitTorrent engine is not available');
    }
    if (s.kind === 'http' && !/^https?:\/\//i.test(s.url)) throw new KotoriError('invalid-argument', 'HTTP download URL must be http(s)');
    if (s.kind === 'jimaku' && !/^https?:\/\//i.test(s.file.url)) throw new KotoriError('invalid-argument', 'Jimaku file URL missing');
  }

  private defaultTargetDir(source: DownloadSource): string {
    const s = this.deps.settings();
    switch (source.kind) {
      case 'torrent':
      case 'http':
        return s.downloads.downloadDir;
      case 'jimaku':
        return join(this.deps.dataDir, 'subtitles', 'jimaku', sanitizeFileName(source.entry.name));
      case 'mokuro-moe':
        return join(this.deps.dataDir, 'manga', sanitizeFileName(source.volume.name));
    }
  }

  /** Store + emit. `force` = status change (emit now, persist now). */
  private commit(task: DownloadTask, force: boolean): void {
    const next = { ...task, updatedAt: this.now() };
    this.tasks.set(next.id, next);
    if (this.disposed) return;
    const last = this.lastEmit.get(next.id) ?? 0;
    const elapsed = this.now() - last;
    if (force || elapsed >= PROGRESS_INTERVAL_MS) {
      const pending = this.pendingEmit.get(next.id);
      if (pending) clearTimeout(pending);
      this.pendingEmit.delete(next.id);
      this.flush(next.id);
    } else if (!this.pendingEmit.has(next.id)) {
      this.pendingEmit.set(
        next.id,
        setTimeout(() => {
          this.pendingEmit.delete(next.id);
          this.flush(next.id);
        }, PROGRESS_INTERVAL_MS - elapsed),
      );
    }
  }

  private flush(taskId: Id): void {
    const task = this.tasks.get(taskId);
    if (!task || this.disposed) return;
    this.lastEmit.set(taskId, this.now());
    this.deps.repo.put(task, this.autoImport.get(taskId));
    this.deps.emit({ type: 'download-updated', task });
  }

  private patch(taskId: Id, fields: Partial<DownloadTask>, force = false): DownloadTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = { ...task, ...fields } as DownloadTask;
    this.commit(next, force || (fields.status !== undefined && fields.status !== task.status));
    return this.tasks.get(taskId);
  }

  /** Start queued tasks up to `maxActiveDownloads`. */
  private pump(): void {
    if (this.disposed) return;
    const max = this.deps.settings().downloads.maxActiveDownloads;
    let active = [...this.tasks.values()].filter((t) => ACTIVE.has(t.status)).length;
    const queued = [...this.tasks.values()].filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const task of queued) {
      if (active >= max) break;
      active += 1;
      void this.run(task.id);
    }
  }

  private async run(taskId: Id): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const controller = new AbortController();
    const running: Running = { controller };
    this.running.set(taskId, running);
    this.patch(taskId, { status: task.kind === 'torrent' ? 'resolving' : 'downloading', speedBps: 0 });
    try {
      switch (task.source.kind) {
        case 'torrent':
          await this.runTorrent(taskId, task.source, running);
          return; // completion handled by torrent events
        case 'http':
          await this.runHttp(taskId, task.source, controller.signal);
          break;
        case 'jimaku':
          await this.runJimaku(taskId, task.source, controller.signal);
          break;
        case 'mokuro-moe':
          await this.runMokuro(taskId, task.source, controller.signal);
          break;
      }
      this.finish(taskId);
    } catch (error) {
      this.fail(taskId, error, controller.signal);
    }
  }

  private finish(taskId: Id, extra: Partial<DownloadTask> = {}): void {
    const t = this.tasks.get(taskId);
    if (!t || FINISHED.has(t.status) || t.status === 'paused') return;
    this.running.delete(taskId);
    this.patch(taskId, { ...extra, status: 'completed', progress: 1, speedBps: 0, completedAt: this.now() }, true);
    this.pump();
  }

  private fail(taskId: Id, error: unknown, signal?: AbortSignal): void {
    this.running.get(taskId)?.torrent?.detach();
    this.running.delete(taskId);
    const t = this.tasks.get(taskId);
    // Paused / cancelled / removed tasks abort their worker on purpose.
    if (!t || t.status === 'paused' || t.status === 'cancelled' || signal?.aborted) {
      this.pump();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[kotori:downloads] ${t.title}: ${message}`);
    this.patch(taskId, { status: 'failed', error: message, speedBps: 0 }, true);
    this.pump();
  }

  private async stopWorker(taskId: Id, deleteFiles: boolean): Promise<void> {
    const run = this.running.get(taskId);
    this.running.delete(taskId);
    if (!run) return;
    run.controller.abort();
    if (run.torrent) {
      run.torrent.detach();
      await this.engine?.remove(run.torrent.handle.infoHash, { deleteFiles });
    }
  }

  private async deleteTaskFiles(task: DownloadTask): Promise<void> {
    const managed = [join(this.deps.dataDir, 'subtitles'), join(this.deps.dataDir, 'manga'), this.deps.settings().downloads.downloadDir].map((d) => resolve(d));
    const paths: string[] = [];
    if (task.kind === 'torrent') {
      for (const f of task.files ?? []) paths.push(join(task.targetDir, ...f.path.split('/')));
    } else if (task.kind === 'mokuro-volume') {
      paths.push(task.targetDir);
    } else if (task.kind === 'http-file' && task.source.kind === 'http') {
      paths.push(join(task.targetDir, sanitizeFileName(task.title)));
    }
    for (const p of paths) {
      const abs = resolve(p);
      // Never delete outside Kotori-managed directories.
      if (managed.some((m) => abs.startsWith(m + sep))) await rm(abs, { recursive: true, force: true });
    }
  }

  // --- streaming fetch helper -------------------------------------------------

  /** Stream `url` to `dest` (Range-resume when a partial file exists). Returns bytes on disk. */
  private async download(taskId: Id, url: string, dest: string, signal: AbortSignal, options: { headers?: Record<string, string>; base?: number; total?: number } = {}): Promise<number> {
    await mkdir(dirname(dest), { recursive: true });
    let existing = 0;
    try {
      existing = (await stat(dest)).size;
    } catch {
      existing = 0;
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (existing > 0) headers['range'] = `bytes=${existing}-`;
    const res = await this.fetchFn(url, { headers, signal });
    if (res.status === 416 && existing > 0) return existing;
    if (!res.ok) throw new KotoriError('network', `HTTP ${res.status} for ${url}`, { details: { status: res.status } });
    const append = res.status === 206 && existing > 0;
    const length = Number(res.headers.get('content-length') ?? NaN);
    const total = options.total ?? (Number.isFinite(length) ? length + (append ? existing : 0) : undefined);
    const base = options.base ?? 0;
    let written = append ? existing : 0;
    const out = createWriteStream(dest, { flags: append ? 'a' : 'w' });
    const started = this.now();
    try {
      if (!res.body) throw new KotoriError('network', 'Empty response body');
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        written += value.byteLength;
        const elapsed = Math.max(1, this.now() - started);
        const speedBps = Math.round(((written - (append ? existing : 0)) * 1000) / elapsed);
        const downloadedBytes = base + written;
        const t = this.tasks.get(taskId);
        const totalBytes = t?.totalBytes ?? (total !== undefined ? base + total : undefined);
        this.patch(taskId, {
          downloadedBytes,
          speedBps,
          ...(totalBytes !== undefined ? { totalBytes, progress: Math.min(0.999, downloadedBytes / Math.max(1, totalBytes)), etaMs: speedBps > 0 ? Math.round(((totalBytes - downloadedBytes) * 1000) / speedBps) : undefined } : {}),
        } as Partial<DownloadTask>);
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    return written;
  }

  // --- workers -------------------------------------------------------------------

  private async runHttp(taskId: Id, source: Extract<DownloadSource, { kind: 'http' }>, signal: AbortSignal): Promise<void> {
    const task = this.get(taskId);
    const dest = join(task.targetDir, sanitizeFileName(task.title));
    const bytes = await this.download(taskId, source.url, dest, signal);
    this.patch(taskId, { downloadedBytes: bytes, totalBytes: bytes });
    if (this.autoImport.get(taskId) && /\.(cbz|zip|mokuro)$/i.test(dest)) {
      this.patch(taskId, { status: 'importing' });
      const { volumeId } = await this.deps.hooks.importManga(dest);
      this.patch(taskId, { importedVolumeId: volumeId });
      this.deps.emit({ type: 'library-changed', scope: 'manga' });
    }
  }

  private async runJimaku(taskId: Id, source: Extract<DownloadSource, { kind: 'jimaku' }>, signal: AbortSignal): Promise<void> {
    const task = this.get(taskId);
    const apiKey = this.deps.settings().anime.jimakuApiKey;
    const dest = join(task.targetDir, sanitizeFileName(source.file.name));
    const bytes = await this.download(taskId, source.file.url, dest, signal, apiKey ? { headers: { authorization: apiKey } } : {});
    this.patch(taskId, { downloadedBytes: bytes, totalBytes: bytes });
    // Collect subtitle files (unzip packs).
    let subtitleFiles: string[] = [];
    if (/\.zip$/i.test(dest)) {
      const entries = unzipSync(await readFile(dest), { filter: (f) => TEXT_SUB.test(f.name) && !f.name.startsWith('__MACOSX/') });
      const outDir = dest.replace(/\.zip$/i, '');
      for (const [name, data] of Object.entries(entries)) {
        const out = join(outDir, sanitizeFileName(name));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, data);
        subtitleFiles.push(out);
      }
      if (subtitleFiles.length === 0) throw new KotoriError('parse', 'Subtitle pack contains no .ass/.srt/.vtt files');
    } else if (TEXT_SUB.test(dest)) {
      subtitleFiles = [dest];
    } else {
      throw new KotoriError('unsupported', `Cannot import ${source.file.extension} subtitle archives (only .zip packs and text subtitles)`);
    }
    const files: DownloadFile[] = subtitleFiles.map((p, index) => ({ index, path: basename(p), sizeBytes: 0, downloadedBytes: 0, selected: true }));
    this.patch(taskId, { files });
    if (!this.autoImport.get(taskId)) return;
    // Match to episodes.
    const targets: Array<{ episodeId: Id; file: string }> = [];
    if (source.episodeId) {
      const want = source.seriesId ? (await this.deps.hooks.listEpisodes(source.seriesId)).find((e) => e.id === source.episodeId)?.parsedName.episode : undefined;
      const byEpisode = want === undefined ? [] : subtitleFiles.filter((f) => parseEpisodeName(basename(f)).episode === want);
      const pick = byEpisode[0] ?? (subtitleFiles.length === 1 ? subtitleFiles[0] : undefined);
      if (pick) targets.push({ episodeId: source.episodeId, file: pick });
    } else if (source.seriesId) {
      const episodes = await this.deps.hooks.listEpisodes(source.seriesId);
      for (const ep of episodes) {
        const n = ep.parsedName.episode;
        const match = n === undefined ? undefined : subtitleFiles.find((f) => parseEpisodeName(basename(f)).episode === n);
        if (match) targets.push({ episodeId: ep.id, file: match });
      }
    }
    if (targets.length === 0) return;
    this.patch(taskId, { status: 'importing' });
    let lastTrack: Id | undefined;
    for (const t of targets) lastTrack = (await this.deps.hooks.attachSubtitle(t.episodeId, t.file, basename(t.file))).trackId;
    if (lastTrack) this.patch(taskId, { importedTrackId: lastTrack });
    this.deps.emit({ type: 'library-changed', scope: 'anime' });
  }

  private async runMokuro(taskId: Id, source: Extract<DownloadSource, { kind: 'mokuro-moe' }>, signal: AbortSignal): Promise<void> {
    const task = this.get(taskId);
    const name = sanitizeFileName(source.volume.name);
    const mokuroPath = join(task.targetDir, `${name}.mokuro`);
    let done = await this.download(taskId, source.volume.mokuroUrl, mokuroPath, signal, { base: 0, total: task.totalBytes ?? 0 });
    if (source.volume.imagesKind === 'archive') {
      const ext = /\.cbz$/i.test(source.volume.imagesUrl) ? '.cbz' : '.zip';
      done += await this.download(taskId, source.volume.imagesUrl, join(task.targetDir, name + ext), signal, { base: done });
    } else {
      // Directory of page images: list it and fetch each file.
      const res = await this.fetchFn(source.volume.imagesUrl, { signal });
      if (!res.ok) throw new KotoriError('network', `HTTP ${res.status} listing ${source.volume.imagesUrl}`);
      const listing = parseMokuroMoeListing(await res.text(), source.volume.imagesUrl);
      const images = listing.entries.filter((e) => e.kind === 'file' && /\.(jpe?g|png|webp|gif|avif)$/i.test(e.name));
      if (images.length === 0) throw new KotoriError('not-found', 'No page images in the catalog directory');
      for (const img of images) {
        if (signal.aborted) throw new KotoriError('cancelled', 'Cancelled');
        done += await this.download(taskId, img.url, join(task.targetDir, name, sanitizeFileName(img.name)), signal, { base: done });
      }
    }
    this.patch(taskId, { downloadedBytes: done, totalBytes: Math.max(done, task.totalBytes ?? 0) });
    if (this.autoImport.get(taskId)) {
      this.patch(taskId, { status: 'importing' });
      const { volumeId } = await this.deps.hooks.importManga(mokuroPath);
      this.patch(taskId, { importedVolumeId: volumeId });
      this.deps.emit({ type: 'library-changed', scope: 'manga' });
    }
  }

  private torrent(): TorrentEngine {
    if (!this.engine) {
      if (!this.deps.torrentEngine) throw new KotoriError('unsupported', 'BitTorrent engine is not available');
      this.engine = this.deps.torrentEngine();
    }
    return this.engine;
  }

  private async runTorrent(taskId: Id, source: Extract<DownloadSource, { kind: 'torrent' }>, running: Running): Promise<void> {
    const task = this.get(taskId);
    const engine = this.torrent();
    const settings = this.deps.settings();
    await mkdir(task.targetDir, { recursive: true });
    const input = source.magnet ? { magnet: source.magnet } : source.torrentUrl ? { torrentUrl: source.torrentUrl } : { infoHash: source.infoHash };
    const handle =
      engine.get(source.infoHash.toLowerCase()) ??
      (await engine.add(input, {
        downloadDir: task.targetDir,
        seedAfterComplete: settings.downloads.seedAfterComplete,
        ...(source.fileIndexes ? { fileIndexes: source.fileIndexes } : {}),
      }));
    if (running.controller.signal.aborted) return;

    const sync = (force: boolean): void => {
      const current = this.tasks.get(taskId);
      if (!current || FINISHED.has(current.status)) return;
      const stats = handle.stats();
      const files: DownloadFile[] = handle.files.map((f) => ({ index: f.index, path: f.path, sizeBytes: f.length, downloadedBytes: f.downloaded, selected: f.selected }));
      const status: DownloadStatus =
        current.status === 'importing' ? 'importing' : handle.status === 'resolving' ? 'resolving' : handle.status === 'paused' ? 'paused' : handle.status === 'error' ? 'failed' : 'downloading';
      this.patch(
        taskId,
        {
          status,
          progress: stats.progress,
          downloadedBytes: stats.downloadedBytes,
          totalBytes: stats.totalBytes,
          speedBps: Math.round(stats.speedBps),
          uploadSpeedBps: Math.round(stats.uploadSpeedBps),
          peers: stats.peers,
          seeds: stats.seeds,
          ...(stats.etaMs !== undefined ? { etaMs: stats.etaMs } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(handle.name && current.title === source.infoHash ? { title: handle.name } : {}),
          ...(handle.error ? { error: handle.error } : {}),
        } as Partial<DownloadTask>,
        force,
      );
    };
    const onProgress = (): void => sync(false);
    const onStatus = (): void => sync(true);
    const onError = (error: Error): void => this.fail(taskId, error);
    const onDone = (): void => {
      sync(true);
      void this.completeTorrent(taskId, handle);
    };
    handle.on('progress', onProgress);
    handle.on('metadata', onStatus);
    handle.on('status', onStatus);
    handle.on('error', onError);
    handle.on('done', onDone);
    running.torrent = {
      handle,
      detach: () => {
        handle.off('progress', onProgress);
        handle.off('metadata', onStatus);
        handle.off('status', onStatus);
        handle.off('error', onError);
        handle.off('done', onDone);
      },
    };
    sync(true);
    if (handle.status === 'seeding' || handle.status === 'completed') onDone();
  }

  private async completeTorrent(taskId: Id, handle: TorrentHandle): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || FINISHED.has(task.status) || task.status === 'importing') return;
    try {
      let importedSeriesId: Id | undefined;
      if (this.autoImport.get(taskId)) {
        this.patch(taskId, { status: 'importing' }, true);
        const rootName = handle.files.length > 1 ? handle.files[0]?.path.split('/')[0] : handle.files[0]?.path;
        const root = rootName ? join(task.targetDir, rootName) : task.targetDir;
        if (existsSync(root)) {
          importedSeriesId = (await this.deps.hooks.importAnime(root)).seriesId;
          this.deps.emit({ type: 'library-changed', scope: 'anime' });
        }
      }
      const run = this.running.get(taskId);
      if (!this.deps.settings().downloads.seedAfterComplete) {
        run?.torrent?.detach();
        await this.engine?.remove(handle.infoHash, { deleteFiles: false });
      }
      this.finish(taskId, importedSeriesId ? { importedSeriesId } : {});
    } catch (error) {
      this.fail(taskId, error);
    }
  }
}
