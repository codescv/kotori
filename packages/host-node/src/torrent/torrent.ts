/**
 * `Torrent`: one swarm download/seed. State machine
 * `resolving → downloading → seeding | completed` (+ `paused`, `error`),
 * peer pool, request pipelining, end-game, upload serving, trackers, DHT.
 *
 * `resolving` covers both "waiting for metadata" (magnets) and "checking
 * existing data" (initial recheck when no resume bitfield exists).
 */
import { EventEmitter } from 'node:events';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DhtNode } from './dht';
import { encodeTorrentFile, infoDictFromMetadata } from './metainfo';
import type { TorrentMeta } from './metainfo';
import { connectSocket, MAX_INFLIGHT, PeerConnection } from './peer';
import { ActivePiece } from './piece-buffer';
import { PiecePicker } from './piece-picker';
import { filePieceRange, Storage } from './storage';
import { SpeedMeter } from './throttle';
import type { TokenBucket } from './throttle';
import { announceHttp } from './tracker-http';
import type { AnnounceEvent, PeerAddress } from './tracker-http';
import type { UdpTrackerClient } from './tracker-udp';
import type { TorrentAddOptions, TorrentFileInfo, TorrentStats, TorrentStatus } from './types';

const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|avi|mov|ts|m2ts|wmv|flv)$/i;
const TICK_MS = 1000;
const MAX_CONNECTING = 8;
const MAX_REQUEST_LENGTH = 128 * 1024;
const DHT_RELOOKUP_MS = 5 * 60_000;

/** Shared client resources handed to each torrent. */
export interface TorrentContext {
  readonly peerId: Uint8Array;
  readonly dataDir: string;
  port(): number;
  readonly dht: DhtNode | undefined;
  /** `undefined` when trackers are disabled. */
  readonly udp: UdpTrackerClient | undefined;
  readonly trackersEnabled: boolean;
  readonly maxPeers: number;
  readonly downloadBucket: TokenBucket;
  readonly uploadBucket: TokenBucket;
}

export interface TorrentInit {
  readonly infoHash: string;
  readonly meta?: TorrentMeta | undefined;
  readonly name?: string | undefined;
  readonly trackers: readonly string[];
  readonly peers: readonly PeerAddress[];
  readonly opts: TorrentAddOptions;
}

interface Candidate {
  readonly host: string;
  readonly port: number;
  failures: number;
  nextAttempt: number;
  busy: boolean;
}

/**
 * Events: `'metadata'()`, `'status'(TorrentStatus)`, `'progress'(TorrentStats)`,
 * `'done'()`, `'error'(Error)` (only emitted when a listener is attached),
 * `'warning'(Error)` (tracker/DHT hiccups).
 */
export class Torrent extends EventEmitter {
  readonly infoHash: string;
  /** Last fatal error message (status `error`). */
  error?: string;

  private readonly ctx: TorrentContext;
  private readonly opts: TorrentAddOptions;
  private readonly infoHashBuf: Uint8Array;
  private readonly magnetName: string | undefined;
  private readonly trackers: string[];
  private meta: TorrentMeta | undefined;
  private storage: Storage | undefined;
  private picker: PiecePicker | undefined;
  private storageReady = false;
  private initPromise: Promise<void> | undefined;
  private _status: TorrentStatus = 'resolving';
  private selected: Set<number> | undefined;
  private priorityFile: number | undefined;

  private readonly peers = new Set<PeerConnection>();
  private readonly announcedTo = new WeakSet<PeerConnection>();
  private readonly candidates = new Map<string, Candidate>();
  private connecting = 0;
  private readonly active = new Map<number, ActivePiece<PeerConnection>>();
  private readonly verifying = new Set<number>();

  private readonly downSpeed = new SpeedMeter();
  private readonly upSpeed = new SpeedMeter();
  private uploaded = 0;
  private downloaded = 0;

  private paused = false;
  private destroyed = false;
  private doneEmitted = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private refillTimer: NodeJS.Timeout | undefined;
  private connectScheduled = false;
  private progressTimer: NodeJS.Timeout | undefined;
  private lastDhtLookup = 0;
  private trackersRunning = false;
  private readonly trackerTimers = new Map<string, NodeJS.Timeout>();
  private readonly trackerKey = Math.floor(Math.random() * 0xffffffff);

  constructor(ctx: TorrentContext, init: TorrentInit) {
    super();
    this.ctx = ctx;
    this.opts = init.opts;
    this.infoHash = init.infoHash;
    this.infoHashBuf = new Uint8Array(Buffer.from(init.infoHash, 'hex'));
    this.magnetName = init.name;
    this.trackers = [...new Set([...init.trackers, ...(init.meta?.announce ?? [])])];
    this.meta = init.meta;
    if (init.opts.fileIndexes) this.selected = new Set(init.opts.fileIndexes);
    for (const p of init.peers) this.addCandidate(p);
    for (const p of init.opts.peers ?? []) this.addCandidate(p);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get name(): string | undefined {
    return this.meta?.name ?? this.magnetName;
  }

  get status(): TorrentStatus {
    return this._status;
  }

  get files(): readonly TorrentFileInfo[] {
    const meta = this.meta;
    if (!meta) return [];
    return meta.files.map((f) => ({
      index: f.index,
      path: f.path,
      length: f.length,
      downloaded: this.storage?.fileDownloaded(f.index) ?? 0,
      selected: this.isSelected(f.index),
    }));
  }

  /** The `.torrent` bytes once metadata is known (to persist resolved magnets). */
  torrentFile(): Uint8Array | undefined {
    return this.meta ? encodeTorrentFile(this.meta) : undefined;
  }

  stats(): TorrentStats {
    let total = 0;
    let done = 0;
    for (const f of this.files) {
      if (!f.selected) continue;
      total += f.length;
      done += f.downloaded;
    }
    const speedBps = this.downSpeed.bps();
    const n = this.meta?.pieces.length ?? 0;
    let peers = 0;
    let seeds = 0;
    for (const pc of this.peers) {
      if (!pc.ready) continue;
      peers++;
      if (pc.isSeed(n)) seeds++;
    }
    const s: TorrentStats = {
      downloadedBytes: done,
      totalBytes: total,
      progress: total > 0 ? done / total : this.meta && this.storageReady ? 1 : 0,
      speedBps,
      uploadSpeedBps: this.upSpeed.bps(),
      peers,
      seeds,
    };
    if (speedBps > 0 && done < total) s.etaMs = Math.round(((total - done) / speedBps) * 1000);
    return s;
  }

  pause(): void {
    if (this.destroyed || this.paused) return;
    this.paused = true;
    this.stopTrackers(true);
    this.disconnectAll();
    void this.storage?.flushBitfield();
    this.refreshStatus();
  }

  resume(): void {
    if (this.destroyed) return;
    const wasError = this._status === 'error';
    if (!this.paused && !wasError) return;
    this.paused = false;
    if (wasError) delete this.error;
    if (this.meta && !this.storageReady) void this.initMeta(this.meta);
    this.refreshStatus();
    this.startDiscovery();
  }

  selectFiles(indexes: readonly number[]): void {
    this.selected = new Set(indexes);
    if (!this.meta || !this.picker) return;
    this.applySelection();
    void this.createEmptySelectedFiles();
    for (const pc of this.peers) this.updateInterest(pc);
    this.refreshStatus();
    this.fillAll();
    this.emitProgress(true);
  }

  /** Gives the sequential bias to file `index` (e.g. the episode being watched). */
  prioritizeFile(index: number | undefined): void {
    this.priorityFile = index;
    this.updatePriority();
  }

  addPeer(peer: { host: string; port: number }): void {
    this.addCandidate(peer);
    this.scheduleConnect();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (driven by TorrentClient)
  // -------------------------------------------------------------------------

  /** @internal Called once by the client after construction. */
  start(): void {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref();
    if (this.meta) void this.initMeta(this.meta);
    this.startDiscovery();
  }

  /** @internal Stops everything; optionally deletes payload + resume files. */
  async destroy(opts: { deleteFiles?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    this.stopTrackers(true);
    this.destroyed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.refillTimer) clearTimeout(this.refillTimer);
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.disconnectAll();
    await this.initPromise?.catch(() => undefined);
    // Let in-flight piece writes settle before closing handles.
    while (this.verifying.size > 0) await new Promise((r) => setTimeout(r, 10));
    if (this.storage) {
      if (opts.deleteFiles) await this.storage.deleteFiles();
      else await this.storage.close();
    }
  }

  /** @internal Routes an incoming connection whose handshake named our info hash. */
  acceptIncoming(pc: PeerConnection): boolean {
    if (this.destroyed || this.paused || this._status === 'completed' || this._status === 'error') return false;
    if (this.peers.size >= this.ctx.maxPeers) return false;
    this.registerPeer(pc);
    pc.start(this.startParams());
    if (!pc.closed) this.onPeerReady(pc);
    return !pc.closed;
  }

  // -------------------------------------------------------------------------
  // Metadata / storage
  // -------------------------------------------------------------------------

  private initMeta(meta: TorrentMeta): Promise<void> {
    if (this.initPromise) return this.initPromise;
    const run = async (): Promise<void> => {
      this.meta = meta;
      for (const u of meta.announce) if (!this.trackers.includes(u)) this.trackers.push(u);
      const storage = new Storage(meta, { downloadDir: this.opts.downloadDir, dataDir: this.ctx.dataDir });
      const picker = new PiecePicker(meta.pieces.length);
      this.storage = storage;
      this.picker = picker;
      if (this.selected) this.selected = new Set([...this.selected].filter((i) => i >= 0 && i < meta.files.length));
      this.applySelection();
      await storage.open(meta.files.filter((f) => this.isSelected(f.index)).map((f) => f.index));
      if (this.destroyed) return;
      for (let i = 0; i < meta.pieces.length; i++) if (storage.has(i)) picker.setHave(i);
      this.storageReady = true;
      this.updatePriority();
      for (const pc of this.peers) {
        pc.setMetadata(meta.infoBuf);
        if (!pc.ready) continue;
        this.countPeer(pc);
        this.announcePieces(pc);
      }
      this.emit('metadata');
      this.refreshStatus(); // → downloading/seeding: updates interest, unchokes, fills
      this.emitProgress(true);
    };
    this.initPromise = run().catch((err: unknown) => {
      this.initPromise = undefined;
      this.fail(err);
    });
    return this.initPromise;
  }

  private onMetadata(buf: Uint8Array): void {
    if (this.meta || this.destroyed) return;
    let meta: TorrentMeta;
    try {
      meta = infoDictFromMetadata(buf, this.trackers);
    } catch {
      return;
    }
    if (meta.infoHash !== this.infoHash) return;
    void this.initMeta(meta);
  }

  private isSelected(index: number): boolean {
    return this.selected === undefined || this.selected.has(index);
  }

  private applySelection(): void {
    const meta = this.meta;
    const picker = this.picker;
    if (!meta || !picker) return;
    const wanted = new Uint8Array(meta.pieces.length);
    for (const f of meta.files) {
      if (!this.isSelected(f.index)) continue;
      const { start, end } = filePieceRange(meta, f);
      wanted.fill(1, start, end);
    }
    picker.setWanted((i) => wanted[i] === 1);
    this.updatePriority();
  }

  private async createEmptySelectedFiles(): Promise<void> {
    const meta = this.meta;
    if (!meta || !this.storage) return;
    for (const f of meta.files) {
      if (f.length !== 0 || !this.isSelected(f.index)) continue;
      const p = this.storage.filePath(f.index);
      try {
        await mkdir(dirname(p), { recursive: true });
        await (await open(p, 'a')).close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Sequential bias: explicit priority file, else first selected incomplete video file. */
  private updatePriority(): void {
    const meta = this.meta;
    const picker = this.picker;
    if (!meta || !picker) return;
    const incomplete = (idx: number): boolean => {
      const f = meta.files[idx];
      if (!f || f.length === 0) return false;
      const { start, end } = filePieceRange(meta, f);
      for (let i = start; i < end; i++) if (!picker.hasPiece(i)) return true;
      return false;
    };
    let target: number | undefined;
    if (this.priorityFile !== undefined && this.isSelected(this.priorityFile) && incomplete(this.priorityFile)) {
      target = this.priorityFile;
    } else {
      target = meta.files.find((f) => this.isSelected(f.index) && VIDEO_EXT.test(f.path) && incomplete(f.index))?.index;
    }
    const f = target === undefined ? undefined : meta.files[target];
    picker.setPriorityRange(f ? filePieceRange(meta, f) : undefined);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private computeStatus(): TorrentStatus {
    if (this.error !== undefined) return 'error';
    if (this.paused) return 'paused';
    if (!this.meta || !this.picker || !this.storageReady) return 'resolving';
    if (this.picker.remaining() === 0) return this.opts.seedAfterComplete ? 'seeding' : 'completed';
    return 'downloading';
  }

  private refreshStatus(): void {
    if (this.destroyed) return;
    const prev = this._status;
    const next = this.computeStatus();
    if (next === prev) return;
    this._status = next;

    const complete = next === 'seeding' || next === 'completed';
    let fireDone = false;
    if (complete && !this.doneEmitted) {
      this.doneEmitted = true;
      fireDone = true;
      void this.storage?.flushBitfield();
      if (prev === 'downloading') this.announceAll('completed');
    }
    if (next === 'downloading') this.doneEmitted = false;

    if (next === 'completed') {
      this.stopTrackers(true);
      this.disconnectAll();
      void this.storage?.flushBitfield().then(() => this.storage?.closeHandles());
    } else if (next === 'seeding') {
      const n = this.meta?.pieces.length ?? 0;
      for (const pc of [...this.peers]) {
        this.updateInterest(pc);
        if (pc.ready && pc.isSeed(n)) pc.destroy(); // seed ↔ seed is useless
      }
      this.startDiscovery();
    } else if (next === 'downloading' || next === 'resolving') {
      this.startDiscovery();
    }
    if (next === 'downloading' || next === 'seeding') {
      for (const pc of this.peers) {
        if (!pc.ready) continue;
        if (next === 'downloading') this.updateInterest(pc);
        if (pc.wire.peerInterested) pc.wire.unchoke();
      }
      this.fillAll();
    }

    this.emit('status', next);
    if (fireDone) {
      this.emitProgress(true);
      this.emit('done');
    }
  }

  private fail(err: unknown): void {
    if (this.destroyed) return;
    const e = err instanceof Error ? err : new Error(String(err));
    this.error = e.message;
    this.stopTrackers(false);
    this.disconnectAll();
    this.refreshStatus();
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }

  private emitProgress(immediate = false): void {
    if (this.destroyed) return;
    if (immediate) {
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      this.emit('progress', this.stats());
      return;
    }
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (!this.destroyed) this.emit('progress', this.stats());
    }, 250);
    this.progressTimer.unref();
  }

  private tick(): void {
    if (this.destroyed) return;
    this.connectLoop();
    if (this._status === 'downloading') {
      this.fillAll();
      this.emitProgress();
    } else if (this._status === 'seeding' && this.peers.size > 0) {
      this.emitProgress();
    }
    const dht = this.ctx.dht;
    if (dht && !this.meta?.private && this.wantsPeers() && Date.now() - this.lastDhtLookup > DHT_RELOOKUP_MS) {
      this.lastDhtLookup = Date.now();
      dht.lookup(this.infoHash);
      if (this.ctx.port() > 0) dht.announce(this.infoHash, this.ctx.port());
    }
  }

  // -------------------------------------------------------------------------
  // Peer discovery & connections
  // -------------------------------------------------------------------------

  private wantsPeers(): boolean {
    return !this.destroyed && !this.paused && (this._status === 'resolving' || this._status === 'downloading');
  }

  private startDiscovery(): void {
    if (this.destroyed || this.paused || this._status === 'completed' || this._status === 'error') return;
    this.startTrackers();
    const dht = this.ctx.dht;
    if (dht && !this.meta?.private && Date.now() - this.lastDhtLookup > 30_000) {
      this.lastDhtLookup = Date.now();
      dht.lookup(this.infoHash);
      if (this.ctx.port() > 0) dht.announce(this.infoHash, this.ctx.port());
    }
    this.scheduleConnect();
  }

  private addCandidate(p: { host: string; port: number }): void {
    if (!p.host || !Number.isInteger(p.port) || p.port <= 0 || p.port > 65535) return;
    const key = `${p.host}:${p.port}`;
    if (this.candidates.has(key)) return;
    this.candidates.set(key, { host: p.host, port: p.port, failures: 0, nextAttempt: 0, busy: false });
  }

  private scheduleConnect(): void {
    if (this.connectScheduled || this.destroyed) return;
    this.connectScheduled = true;
    setImmediate(() => {
      this.connectScheduled = false;
      this.connectLoop();
    });
  }

  private connectLoop(): void {
    if (!this.wantsPeers()) return;
    const now = Date.now();
    for (const c of this.candidates.values()) {
      if (this.peers.size + this.connecting >= this.ctx.maxPeers || this.connecting >= MAX_CONNECTING) break;
      if (c.busy || c.nextAttempt > now) continue;
      void this.connectTo(c);
    }
  }

  private async connectTo(c: Candidate): Promise<void> {
    c.busy = true;
    this.connecting++;
    let pc: PeerConnection | undefined;
    try {
      const socket = await connectSocket(c.host, c.port);
      if (!this.wantsPeers()) {
        socket.destroy();
        c.busy = false;
        return;
      }
      pc = new PeerConnection(socket, true, { host: c.host, port: c.port });
    } catch {
      c.busy = false;
      c.failures++;
      c.nextAttempt = Date.now() + Math.min(300_000, 2_000 * 2 ** c.failures);
      return;
    } finally {
      this.connecting--;
    }
    let wasReady = false;
    pc.once('handshake', () => {
      wasReady = true;
    });
    pc.once('close', () => {
      c.busy = false;
      if (wasReady) {
        c.failures = 0;
        c.nextAttempt = Date.now() + 5_000;
      } else {
        c.failures++;
        c.nextAttempt = Date.now() + Math.min(300_000, 2_000 * 2 ** c.failures);
      }
      this.scheduleConnect();
    });
    this.registerPeer(pc);
    pc.on('handshake', () => this.onPeerReady(pc));
    pc.start(this.startParams());
  }

  private startParams(): { infoHash: Uint8Array; peerId: Uint8Array; metadata: Uint8Array | undefined; dht: boolean } {
    return { infoHash: this.infoHashBuf, peerId: this.ctx.peerId, metadata: this.meta?.infoBuf, dht: this.ctx.dht !== undefined };
  }

  private registerPeer(pc: PeerConnection): void {
    this.peers.add(pc);
    const w = pc.wire;
    w.on('bitfield', () => {
      this.countPeer(pc);
      this.updateInterest(pc);
      this.fill(pc);
    });
    w.on('have', (index: number) => {
      if (this.picker && pc.counted) this.picker.peerHave(index);
      if (!w.amInterested && this.picker?.needs(index)) this.updateInterest(pc);
      this.fill(pc);
    });
    w.on('unchoke', () => this.fill(pc));
    w.on('interested', () => {
      if (this.canUpload()) w.unchoke();
    });
    w.on('uninterested', () => w.choke());
    w.on('request', (index, offset, length, respond) => this.onPeerRequest(index, offset, length, respond));
    w.on('download', (n: number) => {
      this.downloaded += n;
      this.downSpeed.add(n);
    });
    w.on('upload', (n: number) => {
      this.uploaded += n;
      this.upSpeed.add(n);
    });
    pc.on('metadata', (buf: Uint8Array) => this.onMetadata(buf));
    pc.once('close', () => this.onPeerClose(pc));
  }

  private onPeerReady(pc: PeerConnection): void {
    if (pc.closed || this.destroyed) return;
    // De-duplicate by peer id (e.g. simultaneous in/out connections).
    for (const other of this.peers) {
      if (other !== pc && other.ready && other.peerIdHex === pc.peerIdHex) {
        pc.destroy();
        return;
      }
    }
    if (!this.meta) {
      pc.fetchMetadata();
      return;
    }
    if (this.storageReady) this.announcePieces(pc);
    this.countPeer(pc);
    this.updateInterest(pc);
  }

  /** Sends our bitfield once per peer (right after the handshake, or once our data is checked). */
  private announcePieces(pc: PeerConnection): void {
    const storage = this.storage;
    if (!storage || this.announcedTo.has(pc) || !pc.ready) return;
    this.announcedTo.add(pc);
    if (storage.bitfield.count() > 0) pc.wire.bitfield(storage.bitfield.buffer);
  }

  private countPeer(pc: PeerConnection): void {
    if (!this.picker || pc.counted) return;
    pc.counted = true;
    this.picker.addPeer((i) => pc.wire.peerPieces.get(i));
  }

  private onPeerClose(pc: PeerConnection): void {
    this.peers.delete(pc);
    if (this.picker && pc.counted) this.picker.removePeer((i) => pc.wire.peerPieces.get(i));
    pc.counted = false;
    for (const ap of this.active.values()) ap.unmarkAll(pc);
    if (!this.destroyed) {
      this.fillAll();
      this.scheduleConnect();
    }
  }

  private disconnectAll(): void {
    for (const pc of [...this.peers]) pc.destroy();
  }

  private canUpload(): boolean {
    return !this.destroyed && this.storageReady && (this._status === 'downloading' || this._status === 'seeding');
  }

  private onPeerRequest(index: number, offset: number, length: number, respond: (err: Error | null, buf?: Uint8Array) => void): void {
    const storage = this.storage;
    if (!storage || !this.canUpload() || !storage.has(index) || length > MAX_REQUEST_LENGTH) {
      respond(new Error('piece unavailable'));
      return;
    }
    void (async () => {
      await this.ctx.uploadBucket.take(length);
      return storage.readBlock(index, offset, length);
    })().then(
      (buf) => respond(null, buf),
      (err: unknown) => respond(err instanceof Error ? err : new Error(String(err))),
    );
  }

  // -------------------------------------------------------------------------
  // Requesting
  // -------------------------------------------------------------------------

  private updateInterest(pc: PeerConnection): void {
    if (!pc.ready) return;
    const picker = this.picker;
    if (!picker || this._status !== 'downloading') {
      pc.wire.uninterested();
      return;
    }
    for (let i = 0; i < picker.numPieces; i++) {
      if (picker.needs(i) && pc.wire.peerPieces.get(i)) {
        pc.wire.interested();
        return;
      }
    }
    pc.wire.uninterested();
  }

  private fillAll(): void {
    for (const pc of this.peers) this.fill(pc);
  }

  private scheduleRefill(ms: number): void {
    if (this.refillTimer) return;
    this.refillTimer = setTimeout(() => {
      this.refillTimer = undefined;
      this.fillAll();
    }, Math.max(10, ms));
    this.refillTimer.unref();
  }

  private fill(pc: PeerConnection): void {
    if (this._status !== 'downloading' || !this.picker || !this.storage) return;
    let guard = MAX_INFLIGHT * 2;
    while (pc.ready && !pc.wire.peerChoking && pc.wire.amInterested && pc.inflight < MAX_INFLIGHT && guard-- > 0) {
      const next = this.nextRequest(pc);
      if (!next) return;
      const len = next.ap.blockLength(next.block);
      if (!this.ctx.downloadBucket.tryTake(len)) {
        if (next.fresh) this.active.delete(next.ap.index);
        this.scheduleRefill(this.ctx.downloadBucket.waitMs(len));
        return;
      }
      this.sendRequest(pc, next.ap, next.block);
    }
  }

  private nextRequest(pc: PeerConnection): { ap: ActivePiece<PeerConnection>; block: number; fresh: boolean } | undefined {
    const picker = this.picker;
    const storage = this.storage;
    if (!picker || !storage) return undefined;
    const has = (i: number): boolean => pc.wire.peerPieces.get(i);
    for (const ap of this.active.values()) {
      if (!has(ap.index)) continue;
      const b = ap.nextUnrequested();
      if (b !== undefined) return { ap, block: b, fresh: false };
    }
    const busy = new Set<number>([...this.active.keys(), ...this.verifying]);
    const idx = picker.pick(has, busy);
    if (idx !== undefined) {
      const ap = new ActivePiece<PeerConnection>(idx, storage.pieceLength(idx));
      this.active.set(idx, ap);
      return { ap, block: 0, fresh: true };
    }
    if (picker.inEndgame(busy)) {
      for (const ap of this.active.values()) {
        if (!has(ap.index)) continue;
        const b = ap.nextDuplicate(pc);
        if (b !== undefined) return { ap, block: b, fresh: false };
      }
    }
    return undefined;
  }

  private sendRequest(pc: PeerConnection, ap: ActivePiece<PeerConnection>, block: number): void {
    const offset = ap.blockOffset(block);
    const length = ap.blockLength(block);
    ap.markRequested(block, pc);
    pc.inflight++;
    pc.wire.request(ap.index, offset, length, (err, data) => {
      pc.inflight = Math.max(0, pc.inflight - 1);
      if (err || !data) {
        ap.unmarkRequested(block, pc);
        if (!this.destroyed) this.scheduleRefill(0);
        return;
      }
      this.onBlock(pc, ap, block, data);
    });
  }

  private onBlock(pc: PeerConnection, ap: ActivePiece<PeerConnection>, block: number, data: Uint8Array): void {
    if (this.destroyed || this.active.get(ap.index) !== ap) return;
    const others = ap.receive(block, data, pc);
    if (others) {
      for (const o of others) if (o !== pc && !o.closed) o.wire.cancel(ap.index, ap.blockOffset(block), ap.blockLength(block));
    }
    if (ap.complete) {
      this.active.delete(ap.index);
      this.verifying.add(ap.index);
      void this.finishPiece(ap);
    }
    this.fill(pc);
  }

  private async finishPiece(ap: ActivePiece<PeerConnection>): Promise<void> {
    const storage = this.storage;
    const picker = this.picker;
    if (!storage || !picker) return;
    let ok = false;
    try {
      ok = await storage.writePiece(ap.index, ap.buffer);
    } catch (err) {
      this.verifying.delete(ap.index);
      this.fail(err);
      return;
    }
    this.verifying.delete(ap.index);
    if (this.destroyed) return;
    if (ok) {
      picker.setHave(ap.index);
      for (const pc of this.peers) {
        if (!pc.ready) continue;
        pc.wire.have(ap.index);
        if (pc.wire.amInterested) this.updateInterest(pc);
      }
      if (picker.priorityRange && ap.index >= picker.priorityRange.start && ap.index < picker.priorityRange.end) this.updatePriority();
      this.emitProgress();
      this.refreshStatus();
    }
    this.fillAll();
  }

  // -------------------------------------------------------------------------
  // Trackers
  // -------------------------------------------------------------------------

  private bytesLeft(): number {
    if (!this.meta || !this.storage) return Number.MAX_SAFE_INTEGER;
    let left = 0;
    for (const f of this.files) if (f.selected) left += f.length - f.downloaded;
    return left;
  }

  private startTrackers(): void {
    if (!this.ctx.trackersEnabled || this.trackersRunning || this.destroyed) return;
    this.trackersRunning = true;
    for (const url of this.trackers) this.announce(url, 'started');
  }

  private stopTrackers(sendStopped: boolean): void {
    if (!this.trackersRunning) return;
    this.trackersRunning = false;
    for (const t of this.trackerTimers.values()) clearTimeout(t);
    this.trackerTimers.clear();
    if (sendStopped && !this.destroyed) for (const url of this.trackers) this.announce(url, 'stopped', false);
  }

  private announceAll(event: AnnounceEvent): void {
    if (!this.trackersRunning) return;
    for (const url of this.trackers) this.announce(url, event);
  }

  private announce(url: string, event: AnnounceEvent, reschedule = true): void {
    const udp = this.ctx.udp;
    if (!this.ctx.trackersEnabled) return;
    const params = {
      infoHash: this.infoHashBuf,
      peerId: this.ctx.peerId,
      port: this.ctx.port(),
      uploaded: this.uploaded,
      downloaded: this.downloaded,
      left: this.bytesLeft(),
      event,
      numWant: event === 'stopped' ? 0 : 50,
      key: this.trackerKey,
    };
    let p: Promise<{ interval: number; peers: readonly PeerAddress[] }>;
    if (/^https?:/i.test(url)) p = announceHttp(url, params);
    else if (/^udp:/i.test(url) && udp) p = udp.announce(url, params);
    else return;
    const schedule = (sec: number): void => {
      if (!reschedule || !this.trackersRunning || this.destroyed) return;
      const prev = this.trackerTimers.get(url);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => this.announce(url, 'update'), sec * 1000);
      t.unref();
      this.trackerTimers.set(url, t);
    };
    p.then(
      (res) => {
        if (this.destroyed) return;
        for (const peer of res.peers) this.addCandidate(peer);
        this.scheduleConnect();
        schedule(Math.max(60, Math.min(res.interval || 1800, 1800)));
      },
      (err: unknown) => {
        if (!this.destroyed) this.emit('warning', err instanceof Error ? err : new Error(String(err)));
        schedule(300);
      },
    );
  }
}
