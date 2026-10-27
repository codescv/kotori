/**
 * Built-in App Icon presets (`s4-01..04`, `s3-01..04`) and AI Assistant
 * Persona avatar presets (`s4-01..04`, `s3-01..04`, `avatar-01..04`).
 */
import type { AppIconId } from '@kotori/core';
import type { MessageKey } from '../i18n';

export const DEFAULT_APP_ICON: AppIconId = 's4-01';

export interface AppIconPreset {
  readonly id: AppIconId;
  readonly code: string;
  readonly group: 's4' | 's3';
  readonly src: string;
  readonly labelKey: MessageKey;
}

export interface PersonaAvatarPreset {
  readonly id: string;
  readonly code: string;
  readonly group: 's4' | 's3' | 'avatar';
  readonly src: string;
  readonly labelKey: MessageKey;
}

export const APP_ICON_PRESETS: readonly AppIconPreset[] = [
  { id: 's4-01', code: 'S4-01', group: 's4', src: '/icons/s4-01.png', labelKey: 'settings.appearance.icon.s4-01' },
  { id: 's4-02', code: 'S4-02', group: 's4', src: '/icons/s4-02.png', labelKey: 'settings.appearance.icon.s4-02' },
  { id: 's4-03', code: 'S4-03', group: 's4', src: '/icons/s4-03.png', labelKey: 'settings.appearance.icon.s4-03' },
  { id: 's4-04', code: 'S4-04', group: 's4', src: '/icons/s4-04.png', labelKey: 'settings.appearance.icon.s4-04' },
  { id: 's3-01', code: 'S3-01', group: 's3', src: '/icons/s3-01.png', labelKey: 'settings.appearance.icon.s3-01' },
  { id: 's3-02', code: 'S3-02', group: 's3', src: '/icons/s3-02.png', labelKey: 'settings.appearance.icon.s3-02' },
  { id: 's3-03', code: 'S3-03', group: 's3', src: '/icons/s3-03.png', labelKey: 'settings.appearance.icon.s3-03' },
  { id: 's3-04', code: 'S3-04', group: 's3', src: '/icons/s3-04.png', labelKey: 'settings.appearance.icon.s3-04' },
];

export const PERSONA_AVATAR_PRESETS: readonly PersonaAvatarPreset[] = [
  ...APP_ICON_PRESETS,
  { id: 'avatar-01', code: 'A-01', group: 'avatar', src: '/icons/avatar-01.png', labelKey: 'persona.preset.avatar-01' },
  { id: 'avatar-02', code: 'A-02', group: 'avatar', src: '/icons/avatar-02.png', labelKey: 'persona.preset.avatar-02' },
  { id: 'avatar-03', code: 'A-03', group: 'avatar', src: '/icons/avatar-03.png', labelKey: 'persona.preset.avatar-03' },
  { id: 'avatar-04', code: 'A-04', group: 'avatar', src: '/icons/avatar-04.png', labelKey: 'persona.preset.avatar-04' },
];

const VALID_IDS = new Set<string>(APP_ICON_PRESETS.map((p) => p.id));

/** Normalise an optional or unknown icon id to a valid `AppIconId`. */
export function resolveAppIcon(iconId?: string | undefined): AppIconId {
  return iconId && VALID_IDS.has(iconId) ? (iconId as AppIconId) : DEFAULT_APP_ICON;
}

/** Return the public URL for the given `AppIconId`. */
export function appIconUrl(iconId?: string | undefined): string {
  return `/icons/${resolveAppIcon(iconId)}.png`;
}
