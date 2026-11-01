/**
 * Locally configurable Agent Feedback Email (`localStorage` only) and `mailto:`
 * URL builder for routing one-click user feedback to the Vibe Coding dispatcher.
 */
import type { PlatformHost } from '@kotori/core';

export const AGENT_FEEDBACK_EMAIL_STORAGE_KEY = 'kotori_agent_feedback_email';
export const AGENT_FEEDBACK_EMAIL_PLACEHOLDER = 'agent@example.com';
export const KOTORI_UI_VERSION = '0.1.32';

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface StorageReader {
  getItem(key: string): string | null;
}

export interface StorageWriter {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AgentFeedbackMailtoInput {
  readonly email: string;
  readonly summary: string;
  readonly details?: string | undefined;
  readonly version?: string | undefined;
  readonly platform?: string | undefined;
  readonly os?: string | undefined;
}

function defaultStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted contexts.
  }
  return null;
}

/** Validate a user-entered recipient email address (rejecting empty or header-injection chars). */
export function isValidFeedbackEmail(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (/[\r\n\0]/.test(trimmed)) return false;
  return EMAIL_PATTERN.test(trimmed);
}

/** Read the locally persisted Agent Feedback Email from `localStorage` (default `""`). */
export function readAgentFeedbackEmail(storage?: StorageReader | null): string {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return '';
  try {
    const raw = target.getItem(AGENT_FEEDBACK_EMAIL_STORAGE_KEY);
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

/** Persist (or clear when empty) the Agent Feedback Email in `localStorage`. */
export function writeAgentFeedbackEmail(email: string, storage?: StorageWriter | null): string {
  const trimmed = email.trim();
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return trimmed;
  try {
    if (trimmed === '') {
      target.removeItem(AGENT_FEEDBACK_EMAIL_STORAGE_KEY);
    } else {
      target.setItem(AGENT_FEEDBACK_EMAIL_STORAGE_KEY, trimmed);
    }
  } catch {
    // Ignore quota / security errors in restricted contexts.
  }
  return trimmed;
}

/** Normalize app version for feedback subjects, substituting `KOTORI_UI_VERSION` on mock hosts. */
export function resolveFeedbackVersion(version?: string, platform?: string): string {
  const cleaned = (version ?? '').trim().replace(/^[vV]/, '');
  if (!cleaned || platform === 'mock' || cleaned.endsWith('-mock')) {
    return KOTORI_UI_VERSION;
  }
  return cleaned;
}

/** Derive a single-line summary from explicit `summary` or the first line of `details`. */
export function deriveFeedbackSummary(summary: string, details?: string): string {
  const inlineSummary = summary.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (inlineSummary.length > 0) return inlineSummary;
  const firstDetailLine = (details ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t+/g, ' ').trim())
    .find((line) => line.length > 0);
  if (firstDetailLine) {
    return firstDetailLine.length > 60 ? `${firstDetailLine.slice(0, 60)}…` : firstDetailLine;
  }
  return '用户反馈';
}

/** Format the `kotori:`-prefixed subject routed by the Vibe Coding dispatcher. */
export function buildAgentFeedbackSubject(summary: string, version?: string, platform?: string): string {
  const ver = resolveFeedbackVersion(version, platform);
  const cleanSummary = deriveFeedbackSummary(summary);
  return `kotori: [v${ver}] ${cleanSummary}`;
}

/** Build the plain-text email body with user feedback and compact version/platform diagnostics. */
export function buildAgentFeedbackBody(input: Omit<AgentFeedbackMailtoInput, 'email'>): string {
  const ver = resolveFeedbackVersion(input.version, input.platform);
  const cleanSummary = deriveFeedbackSummary(input.summary, input.details);
  const cleanDetails = (input.details ?? '').trim();
  const sections: string[] = [];
  if (cleanDetails.length > 0 && cleanDetails !== cleanSummary) {
    if (input.summary.trim().length > 0) {
      sections.push(cleanSummary, '', cleanDetails);
    } else {
      sections.push(cleanDetails);
    }
  } else {
    sections.push(cleanSummary);
  }
  const metaLines = [`App: Kotori v${ver}`];
  if (input.platform || input.os) {
    const envParts = [input.platform, input.os].filter(Boolean);
    if (envParts.length > 0) metaLines.push(`Platform: ${envParts.join(' · ')}`);
  }
  sections.push('', '---', ...metaLines);
  return sections.join('\n');
}

/** Build a RFC 6068 `mailto:` URL pre-addressed to `email` with `kotori: [vX.Y.Z] <summary>`. */
export function buildAgentFeedbackMailto(input: AgentFeedbackMailtoInput): string {
  const trimmedEmail = input.email.trim();
  if (!isValidFeedbackEmail(trimmedEmail)) {
    throw new Error('Invalid agent feedback email address');
  }
  const effectiveSummary = deriveFeedbackSummary(input.summary, input.details);
  const subject = buildAgentFeedbackSubject(effectiveSummary, input.version, input.platform);
  const body = buildAgentFeedbackBody({ ...input, summary: effectiveSummary });
  return `mailto:${trimmedEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Launch a `mailto:` link via `host.files.openExternal` (or browser anchor fallback). */
export async function launchAgentFeedbackMailto(host: PlatformHost, mailtoUrl: string): Promise<void> {
  if (host.files.openExternal) {
    await host.files.openExternal(mailtoUrl);
    return;
  }
  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = mailtoUrl;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  }
}
