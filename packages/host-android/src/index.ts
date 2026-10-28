/**
 * @kotori/host-android — in-process `PlatformHost` for the Capacitor WebView.
 * Owner: coder-2.
 *
 * Layout (see ARCHITECTURE.md §7):
 *   capacitor-host.ts   `createCapacitorPlatformHost(deps?)` — wires everything below
 *   default-deps.ts     production deps (Filesystem, convertFileSrc, pickers, openExternal)
 *   deps.ts             injectable dependency + `FsOps` interfaces
 *   adapters/core.ts    core runtime functions (local fallbacks until @kotori/core lands)
 *   storage/idb.ts      IndexedDB (idb) stores mirroring the desktop tables
 *   storage/files.ts    @capacitor/filesystem wrappers; app dirs under Directory.Data
 *   settings.ts         defaults (= desktop), deep-merge patch, settings-changed
 *   library/anime.ts    folder scan → series/episodes/sidecar tracks; cues LRU
 *   library/manga.ts    .mokuro / CBZ (fflate, extracted once) / image dir import
 *   ai.ts               explain engine + IndexedDB explanation cache / threads
 *   downloads.ts        Jimaku / mokuro.moe / HTTP downloads; torrents → external app
 *   dict.ts             local Yomitan dictionaries over IndexedDB (DictionaryHost)
 *   native-tts.ts       Web Speech shim over the native TextToSpeech plugin
 */
export { createCapacitorPlatformHost, ANDROID_CAPABILITIES } from './capacitor-host';
export type { CapacitorHostDeps, FsEntry, FsOps, PickFilesOptions } from './deps';
export { defaultSettings, mergeSettings } from './settings';
export { createNativeSpeechSynthesis, installNativeSpeechSynthesis, NativeSpeechUtterance, type NativeSpeechPlugin } from './native-tts';

export type CreateCapacitorPlatformHost = typeof import('./capacitor-host').createCapacitorPlatformHost;
