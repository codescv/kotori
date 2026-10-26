/** Snackbar queue (M3 snackbars are shown one at a time, bottom-centre). */
import { create } from 'zustand';

export interface SnackbarMessage {
  readonly id: number;
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'error';
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface SnackbarState {
  readonly queue: readonly SnackbarMessage[];
  show(text: string, opts?: { tone?: SnackbarMessage['tone']; action?: SnackbarMessage['action'] }): void;
  dismiss(id: number): void;
  reset(): void;
}

let nextId = 1;

export const useSnackbarStore = create<SnackbarState>()((set) => ({
  queue: [],
  show(text, opts) {
    const message: SnackbarMessage = {
      id: nextId++,
      text,
      tone: opts?.tone ?? 'info',
      ...(opts?.action ? { action: opts.action } : {}),
    };
    set((s) => ({ queue: [...s.queue, message].slice(-5) }));
  },
  dismiss(id) {
    set((s) => ({ queue: s.queue.filter((m) => m.id !== id) }));
  },
  reset() {
    set({ queue: [] });
  },
}));

/** Imperative helper usable outside React components. */
export const showSnackbar = (text: string, opts?: Parameters<SnackbarState['show']>[1]): void =>
  useSnackbarStore.getState().show(text, opts);
