/**
 * AI Assistant avatar badge (`AssistantAvatar`) and the Persona configuration
 * dialog (`PersonaDialog`) opened by clicking the top-left brand icon (`こ`).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AiPersonaSettings } from '@kotori/core';
import { useRouteStore } from '../app/routes';
import { useIsExpanded } from '../hooks/useMediaQuery';
import { useHost } from '../host/HostContext';
import { useT } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
import { PERSONA_AVATAR_PRESETS } from '../theme/app-icons';
import { Button } from './m3/Button';
import { cx } from './m3/cx';
import { Dialog } from './m3/Dialog';
import { TextField } from './m3/TextField';

export interface AssistantAvatarProps {
  readonly persona?: AiPersonaSettings | undefined;
  readonly className?: string | undefined;
  readonly size?: number | undefined;
}

/**
 * Renders the AI assistant's custom image (`avatarUrl`), or the first glyph of
 * `name`, falling back to the default Kotori kana mark `こ`.
 */
export function AssistantAvatar({ persona: personaProp, className, size }: AssistantAvatarProps) {
  const storePersona = useSettingsStore((s) => s.settings.ai.persona);
  const persona = personaProp ?? storePersona;
  const avatarUrl = persona?.avatarUrl?.trim();
  const name = persona?.name?.trim();
  const fallbackChar = (name ? Array.from(name)[0] : undefined) ?? 'こ';

  return (
    <span
      className={cx('k-brand-mark', 'k-assistant-avatar', className)}
      style={size ? { width: size, height: size, fontSize: Math.round(size * 0.5) } : undefined}
      data-testid="assistant-avatar"
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name || 'こ'} className="k-assistant-avatar__img" />
      ) : (
        fallbackChar
      )}
    </span>
  );
}

/**
 * Top-left AI assistant trigger button rendered in page headers on compact
 * viewports (Android / phones `< 840px`), where the desktop `NavRail` is hidden.
 */
export function CompactBrandButton() {
  const expanded = useIsExpanded();
  const t = useT();
  const setPersonaOpen = useRouteStore((s) => s.setPersonaOpen);
  if (expanded) return null;
  return (
    <button
      type="button"
      className="k-nav-rail__brand-btn k-compact-brand-btn"
      aria-label={t('persona.title')}
      title={t('persona.title')}
      onClick={() => setPersonaOpen(true)}
      data-testid="brand-persona-trigger"
    >
      <AssistantAvatar size={36} />
    </button>
  );
}

export interface PersonaDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Dialog for configuring the AI assistant's nickname, avatar image, and follow-up soul. */
export function PersonaDialog({ open, onClose }: PersonaDialogProps) {
  const t = useT();
  const host = useHost();
  const persona = useSettingsStore((s) => s.settings.ai.persona);
  const update = useSettingsStore((s) => s.update);

  const [name, setName] = useState(persona?.name ?? '');
  const [avatarUrl, setAvatarUrl] = useState(persona?.avatarUrl ?? '');
  const [soul, setSoul] = useState(persona?.soul ?? '');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(persona?.name ?? '');
    setAvatarUrl(persona?.avatarUrl ?? '');
    setSoul(persona?.soul ?? '');
  }, [open, persona?.name, persona?.avatarUrl, persona?.soul]);

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setAvatarUrl(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await update(host, {
        ai: {
          persona: {
            name: name.trim(),
            avatarUrl: avatarUrl.trim(),
            soul: soul.trim(),
          },
        },
      });
      showSnackbar(t('settings.saved'));
      onClose();
    } catch (e) {
      showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('persona.title')}
      icon="sparkle"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="filled" disabled={saving} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="k-persona-preview">
        <AssistantAvatar persona={{ name, avatarUrl, soul }} size={52} />
        <div className="k-persona-preview__info">
          <div className="k-title-medium">{name.trim() || 'こ'}</div>
          <div className="k-row">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={onFileChange}
              data-testid="persona-avatar-file"
            />
            <Button variant="tonal" icon="upload" onClick={() => fileRef.current?.click()}>
              {t('persona.uploadImage')}
            </Button>
            {avatarUrl.trim() && (
              <Button variant="text" onClick={() => setAvatarUrl('')}>
                {t('persona.resetAvatar')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="k-persona-presets" data-testid="persona-avatar-presets">
        <span className="k-label-medium k-muted">{t('persona.presets')}</span>
        <div className="k-persona-presets__grid" role="radiogroup" aria-label={t('persona.presets')}>
          {PERSONA_AVATAR_PRESETS.map((preset) => {
            const selected = avatarUrl.trim() === preset.src;
            const label = t(preset.labelKey);
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={label}
                title={label}
                data-testid={`persona-preset-${preset.id}`}
                className={cx('k-persona-preset-btn', selected && 'is-selected')}
                onClick={() => setAvatarUrl(preset.src)}
              >
                <img src={preset.src} alt={label} className="k-persona-preset-btn__img" />
                <span className="k-persona-preset-btn__code">{preset.code}</span>
              </button>
            );
          })}
        </div>
      </div>
      <TextField
        label={t('persona.name')}
        placeholder={t('persona.namePlaceholder')}
        value={name}
        onValueChange={setName}
      />
      <TextField
        label={t('persona.avatar')}
        placeholder="https://... / data:image/..."
        value={avatarUrl}
        onValueChange={setAvatarUrl}
      />
      <TextField
        label={t('persona.soul')}
        supportingText={t('persona.soulHelp')}
        multiline
        rows={4}
        value={soul}
        onValueChange={setSoul}
      />
    </Dialog>
  );
}
