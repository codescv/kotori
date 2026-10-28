/**
 * @kotori/core public surface.
 *
 * Platform-neutral: this package MUST NOT import `node:*`, Capacitor, React or
 * DOM-only APIs (the `DOM` lib is enabled only for `fetch`/`TextDecoder`/
 * `crypto.subtle` typings that exist in both browsers and Node 22+).
 */
export type * from './types';
export * from './util/index';
export * from './ai/index';
export * from './subtitle/index';
export * from './manga/index';
export * from './acquire/index';
export * from './dict/index';
