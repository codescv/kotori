/**
 * In-memory `PlatformHost` with fixture data for the UI dev harness and tests.
 * Owner: coder-3. Must implement EVERY PlatformHost method (no `unsupported`
 * throws except where capabilities say so) and emit HostEvents for downloads.
 *
 * Planned: `createMockPlatformHost(options?: { seed?: MockSeed }): PlatformHost`
 */
export interface MockHostOptions {
  /** Artificial latency per call, ms (default 120). */
  readonly latencyMs?: number;
}
