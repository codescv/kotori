/**
 * CLI entry: `kotori [--port 7865] [--data-dir ~/.kotori] [--no-open] [--dev]`.
 * Owner: coder-2.
 */
import { DEFAULT_PORT, type ServerOptions } from './index';

export function parseArgs(argv: readonly string[]): ServerOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return {
    host: get('--host') ?? '127.0.0.1',
    port: Number(get('--port') ?? DEFAULT_PORT),
    dataDir: get('--data-dir') ?? `${home}/.kotori`,
    openBrowser: !argv.includes('--no-open'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  console.log('[kotori] scaffold — server not implemented yet', options);
}
