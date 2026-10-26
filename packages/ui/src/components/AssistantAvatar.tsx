/**
 * AI Assistant avatar badge (`AssistantAvatar`) and the Persona configuration
 * dialog (`PersonaDialog`) opened by clicking the top-left brand icon (`こ`).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AiPersonaSettings } from '@kotori/core';
import { useHost } from '../host/HostContext';
import { useT } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { showSnackbar } from '../stores/snackbar';
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
