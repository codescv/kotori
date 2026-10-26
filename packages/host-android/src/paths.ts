/**
 * Path helpers that work for absolute POSIX paths (`/data/…`) and URIs
 * (`file:///…`, `content://…`). Always forward slashes.
 */

/** Join path segments, collapsing duplicate slashes (but keeping `scheme://`). */
export function joinPath(base: string, ...segments: readonly string[]): string {
  let out = base.replace(/\/+$/, '');
  for (const raw of segments) {
    const seg = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (seg === '') continue;
    out = `${out}/${seg}`;
  }
  return out === '' ? '/' : out;
}

/** Parent directory (`file:///a/b.mkv` → `file:///a`). */
export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '';
  const parent = trimmed.slice(0, idx);
  return /^[a-z][\w+.-]*:\/?\/?$/i.test(parent) ? `${parent}/` : parent === '' ? '/' : parent;
}

/** Last path segment, URI-decoded. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Lower-case extension without dot. */
export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** File name without extension. */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Make a string safe as a single file-name segment. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 200);
}

/** True when `child` is `parent` or lies beneath it. */
export function isWithin(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, '');
  return child === p || child.startsWith(`${p}/`);
}
