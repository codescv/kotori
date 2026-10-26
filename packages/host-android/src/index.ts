/**
 * @kotori/host-android — in-process `PlatformHost` for the Capacitor WebView.
 * Owner: coder-2.
 *
 * Planned layout (see ARCHITECTURE.md §7):
 *   capacitor-host.ts   `createCapacitorPlatformHost(): Promise<PlatformHost>`
 *                       capabilities: torrent=false, embeddedSubtitles=false, vertexAdc=false,
 *                       directoryPicker=true (SAF), filePicker=true, pathBrowser=false,
 *                       streaming=true, openExternal=true (magnet → external BT app)
 *   storage/idb.ts      IndexedDB (idb) stores: settings, series, episodes, tracks, volumes,
 *                       pages, explanations, threads, downloads
 *   storage/files.ts    @capacitor/filesystem wrappers; `Capacitor.convertFileSrc` for mediaUrl
 *   library/*.ts        anime scanner / manga importer over Filesystem (reuse @kotori/core parsers)
 *   ai.ts               wires @kotori/core explain-service with `fetch` (Gemini API key or
 *                       Vertex access-token / express key; ADC unsupported on device)
 *   downloads.ts        HTTP downloads (Jimaku, mokuro.moe) with progress → HostEvent;
 *                       torrents hand off via `files.openExternal(magnet)`
 */
import type { PlatformHost } from '@kotori/core';

export type CreateCapacitorPlatformHost = () => Promise<PlatformHost>;
