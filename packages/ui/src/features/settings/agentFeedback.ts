/**
 * Locally configurable Agent Feedback Email (`localStorage` only) and `mailto:`
 * URL builder for routing one-click user feedback to the Vibe Coding dispatcher.
 */
import type { PlatformHost } from '@kotori/core';

export const AGENT_FEEDBACK_EMAIL_STORAGE_KEY = 'kotori_agent_feedback_email';
export const AGENT_FEEDBACK_EMAIL_PLACEHOLDER = 'agent@example.com';
export const KOTORI_UI_VERSION = '0.1.42';

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
  /** File name of an attached image (listed as `Attachment: <name>` in the body metadata). */
  readonly attachmentName?: string | undefined;
}

/** Image picked in the feedback dialog, carried as a raw Base64 payload (no `data:` prefix). */
export interface AgentFeedbackAttachment {
  readonly name: string;
  readonly type: string;
  readonly base64: string;
  readonly size?: number | undefined;
}

/** Fully composed feedback email (recipient, subject, plain-text body, optional image). */
export interface AgentFeedbackEmail {
  readonly email: string;
  readonly subject: string;
  readonly body: string;
  readonly mailtoUrl: string;
  readonly attachment?: AgentFeedbackAttachment | undefined;
}

/** Native `KotoriTorrent.sendFeedbackEmail` (Android `ACTION_SEND` with a FileProvider image). */
export interface NativeFeedbackEmailOptions {
  readonly email: string;
  readonly subject: string;
  readonly body: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly base64: string;
}

interface NativeFeedbackPlugin {
  sendFeedbackEmail?: (options: NativeFeedbackEmailOptions) => Promise<unknown>;
}

interface CapacitorFeedbackGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { KotoriTorrent?: NativeFeedbackPlugin };
}

/** Upper bound for attached images (Base64 travels over the Capacitor bridge). */
export const AGENT_FEEDBACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
  const attachmentName = sanitizeAttachmentName(input.attachmentName);
  if (attachmentName) metaLines.push(`Attachment: ${attachmentName}`);
  sections.push('', '---', ...metaLines);
  return sections.join('\n');
}

/** Build a RFC 6068 `mailto:` URL pre-addressed to `email` with `kotori: [vX.Y.Z] <summary>`. */
export function buildAgentFeedbackMailto(input: AgentFeedbackMailtoInput): string {
  return buildAgentFeedbackEmail(input).mailtoUrl;
}

/** Compose recipient, subject, body and `mailto:` URL (plus optional image) for one feedback email. */
export function buildAgentFeedbackEmail(
  input: AgentFeedbackMailtoInput,
  attachment?: AgentFeedbackAttachment,
): AgentFeedbackEmail {
  const trimmedEmail = input.email.trim();
  if (!isValidFeedbackEmail(trimmedEmail)) {
    throw new Error('Invalid agent feedback email address');
  }
  const effectiveSummary = deriveFeedbackSummary(input.summary, input.details);
  const subject = buildAgentFeedbackSubject(effectiveSummary, input.version, input.platform);
  const body = buildAgentFeedbackBody({
    ...input,
    summary: effectiveSummary,
    attachmentName: input.attachmentName ?? attachment?.name,
  });
  const mailtoUrl = `mailto:${trimmedEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return attachment
    ? { email: trimmedEmail, subject, body, mailtoUrl, attachment }
    : { email: trimmedEmail, subject, body, mailtoUrl };
}

/** Strip path separators / control characters from a user-supplied attachment file name. */
export function sanitizeAttachmentName(name?: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Read a picked image `File` into `{ name, type, base64 }` (Base64 without the `data:` prefix). */
export function readAgentFeedbackAttachment(file: File): Promise<AgentFeedbackAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({
        name: sanitizeAttachmentName(file.name) || 'feedback-image',
        type: file.type || 'image/*',
        base64,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

function nativeFeedbackPlugin(): NativeFeedbackPlugin | undefined {
  if (typeof window === 'undefined') return undefined;
  const cap = (window as unknown as { Capacitor?: CapacitorFeedbackGlobal }).Capacitor;
  if (!cap) return undefined;
  if (typeof cap.isNativePlatform === 'function' && !cap.isNativePlatform()) return undefined;
  const plugin = cap.Plugins?.KotoriTorrent;
  return plugin && typeof plugin.sendFeedbackEmail === 'function' ? plugin : undefined;
}

function isUnimplementedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'UNIMPLEMENTED' || (typeof message === 'string' && /not implemented/i.test(message));
}

/**
 * Launch the feedback email. With an image attached on Android
 * (`window.Capacitor.Plugins.KotoriTorrent.sendFeedbackEmail`) the native plugin
 * writes the image under `cacheDir/feedback/` and fires `ACTION_SEND` with a
 * FileProvider `EXTRA_STREAM`. Otherwise (no image / no native plugin) opens the
 * `mailto:` link via `host.files.openExternal` (or a browser anchor fallback).
 */
export async function launchAgentFeedbackMailto(
  host: PlatformHost,
  mailtoUrl: string,
  feedback?: AgentFeedbackEmail,
): Promise<void> {
  const attachment = feedback?.attachment;
  if (feedback && attachment) {
    const plugin = nativeFeedbackPlugin();
    if (plugin?.sendFeedbackEmail) {
      try {
        await plugin.sendFeedbackEmail({
          email: feedback.email,
          subject: feedback.subject,
          body: feedback.body,
          fileName: attachment.name,
          mimeType: attachment.type,
          base64: attachment.base64,
        });
        return;
      } catch (error) {
        if (!isUnimplementedError(error)) throw error;
        // Older native shell without sendFeedbackEmail: fall back to plain mailto below.
      }
    }
  }
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
