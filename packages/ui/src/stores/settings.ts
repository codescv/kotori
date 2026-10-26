/**
 * Settings store: the host's `AppSettings` cached in memory, refreshed by
 * `settings-changed` events. Reads never block on the host (defaults until
 * `load()` resolves) so the theme and locale render immediately.
 */
import { create } from 'zustand';
import type { AppSettings, PlatformHost, SettingsPatch } from '@kotori/core';
import { applySettingsPatch, DEFAULT_SETTINGS } from '../app/default-settings';

export interface SettingsState {
  readonly settings: AppSettings;
  readonly loaded: boolean;
  load(host: PlatformHost): Promise<AppSettings>;
  /** Optimistic update: applies the patch locally, then reconciles with the host's answer. */
  update(host: PlatformHost, patch: SettingsPatch): Promise<AppSettings>;
  /** Replace from a `settings-changed` event. */
  receive(settings: AppSettings): void;
  reset(): void;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load(host) {
    const settings = await host.settings.get();
    set({ settings, loaded: true });
    return settings;
  },
  async update(host, patch) {
    const previous = get().settings;
    set({ settings: applySettingsPatch(previous, patch) });
    try {
      const settings = await host.settings.update(patch);
      set({ settings, loaded: true });
      return settings;
    } catch (error) {
      set({ settings: previous });
      throw error;
    }
  },
  receive(settings) {
    set({ settings, loaded: true });
  },
  reset() {
    set({ settings: DEFAULT_SETTINGS, loaded: false });
  },
}));
