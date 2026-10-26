/**
 * Downloads store: tasks keyed by id, loaded with `downloads.list()` and
 * patched live by `download-updated` / `download-removed` host events.
 */
import { create } from 'zustand';
import type { DownloadTask, HostEvent, Id, PlatformHost } from '@kotori/core';

export interface DownloadsState {
  readonly tasks: ReadonlyMap<Id, DownloadTask>;
  readonly loaded: boolean;
  readonly error: string | undefined;
  load(host: PlatformHost): Promise<void>;
  /** Apply a host event (ignores unrelated event types). */
  receive(event: HostEvent): void;
  upsert(task: DownloadTask): void;
  reset(): void;
}

export const useDownloadsStore = create<DownloadsState>()((set) => ({
  tasks: new Map(),
  loaded: false,
  error: undefined,
  async load(host) {
    try {
      const list = await host.downloads.list();
      set((s) => {
        // Keep any newer event-delivered state for tasks we already know.
        const next = new Map<Id, DownloadTask>();
        for (const t of list) {
          const known = s.tasks.get(t.id);
          next.set(t.id, known && known.updatedAt > t.updatedAt ? known : t);
        }
        for (const [id, t] of s.tasks) if (!next.has(id)) next.set(id, t);
        return { tasks: next, loaded: true, error: undefined };
      });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },
  receive(event) {
    if (event.type === 'download-updated') {
      set((s) => ({ tasks: new Map(s.tasks).set(event.task.id, event.task) }));
    } else if (event.type === 'download-removed') {
      set((s) => {
        if (!s.tasks.has(event.taskId)) return s;
        const next = new Map(s.tasks);
        next.delete(event.taskId);
        return { tasks: next };
      });
    }
  },
  upsert(task) {
    set((s) => ({ tasks: new Map(s.tasks).set(task.id, task) }));
  },
  reset() {
    set({ tasks: new Map(), loaded: false, error: undefined });
  },
}));

/** Tasks newest first. */
export function sortTasks(tasks: ReadonlyMap<Id, DownloadTask>): DownloadTask[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}
