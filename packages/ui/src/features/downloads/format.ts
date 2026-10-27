/** Human-readable byte / speed / duration formatting for the downloads UI. */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[u]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/** `1h 02m`, `3m 05s`, `12s`. */
export function formatEta(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatDate(epochMs: number | undefined): string {
  if (epochMs === undefined) return '';
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Compact character count (`149677` → `15.0万字` or `8,400字`). */
export function formatCharCount(chars: number | undefined): string {
  if (chars === undefined || !Number.isFinite(chars) || chars <= 0) return '';
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)}万字`;
  return `${chars.toLocaleString()}字`;
}

/** Extract technical release badges (codec, bit depth, audio, source, subtitle type) from a torrent/file title. */
export function extractMediaTags(title: string): readonly string[] {
  const tags: string[] = [];
  if (/\b(?:HEVC|x265|H\.?265)\b/i.test(title)) tags.push('HEVC');
  else if (/\b(?:AV1)\b/i.test(title)) tags.push('AV1');
  else if (/\b(?:AVC|x264|H\.?264)\b/i.test(title)) tags.push('AVC');
  if (/\b10[\s-]?bit\b/i.test(title)) tags.push('10-bit');
  if (/\b(?:FLAC)\b/i.test(title)) tags.push('FLAC');
  else if (/\b(?:EAC3|E-AC-3|DDP)\b/i.test(title)) tags.push('EAC3');
  else if (/\b(?:AAC)\b/i.test(title)) tags.push('AAC');
  if (/\b(?:BD|BDRip|Blu-?ray)\b/i.test(title)) tags.push('BD');
  else if (/\b(?:WEB-?DL|WEBRip)\b/i.test(title)) tags.push('WEB');
  if (/\b(?:Multi[\s-]?Subs?|Multiple[\s-]?Subtitles)\b/i.test(title)) tags.push('Multi-Sub');
  if (/\b(?:Dual[\s-]?Audio)\b/i.test(title)) tags.push('Dual-Audio');
  return tags;
}
