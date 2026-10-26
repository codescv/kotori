/**
 * Small settings building blocks: a titled section card, text / number fields
 * that commit on blur or Enter (so every keystroke does not round-trip to the
 * host), and a hook that patches settings with snackbar error reporting.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SettingsPatch } from '@kotori/core';
import { Icon, type IconName } from '../../components/m3/Icon';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';

export function SettingsSection({ title, icon, children, id }: { readonly title: string; readonly icon: IconName; readonly children: ReactNode; readonly id?: string }) {
  return (
    <section className="k-settings-section" aria-labelledby={id ? `${id}-title` : undefined} data-testid={id}>
      <h2 className="k-settings-section__title" id={id ? `${id}-title` : undefined}>
        <Icon name={icon} size={20} />
        {title}
      </h2>
      <div className="k-settings-section__body">{children}</div>
    </section>
  );
}

/** Returns `patch(p)` that applies a settings patch via the store, reporting failures. */
export function usePatchSettings(): (patch: SettingsPatch) => Promise<void> {
  const host = useHost();
  const t = useT();
  const update = useSettingsStore((s) => s.update);
  return useCallback(
    async (patch: SettingsPatch) => {
      try {
        await update(host, patch);
      } catch (e) {
        showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
      }
    },
    [host, t, update],
  );
}

interface CommitTextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly type?: 'text' | 'password' | 'url';
  readonly supportingText?: ReactNode;
  readonly validate?: (value: string) => string | undefined;
  readonly placeholder?: string;
}

/** Text field with local draft state; commits when blurred or on Enter. */
export function CommitTextField({ label, value, onCommit, type = 'text', supportingText, validate }: CommitTextFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = validate?.(draft);
  const commit = (): void => {
    if (draft !== value && !validate?.(draft)) onCommit(draft);
  };
  return (
    <TextField
      label={label}
      value={draft}
      type={type}
      onValueChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      supportingText={supportingText}
      error={error}
    />
  );
}

interface NumberFieldProps {
  readonly label: string;
  readonly value: number | undefined;
  readonly onCommit: (value: number | undefined) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Allow an empty field (→ `undefined`). */
  readonly optional?: boolean;
  readonly supportingText?: ReactNode;
}

/** Numeric field with range validation; commits on blur / Enter. */
export function NumberField({ label, value, onCommit, min, max, step = 1, optional, supportingText }: NumberFieldProps) {
  const t = useT();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const parsed = draft.trim() === '' ? undefined : Number(draft);
  const invalid =
    (parsed === undefined && !optional) ||
    (parsed !== undefined && (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)));
  const commit = (): void => {
    if (!invalid && parsed !== value) onCommit(parsed);
  };
  return (
    <TextField
      label={label}
      value={draft}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      onValueChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      supportingText={supportingText}
      error={invalid ? `${t('settings.invalidNumber')}${min !== undefined || max !== undefined ? ` (${min ?? '−∞'} … ${max ?? '∞'})` : ''}` : undefined}
    />
  );
}
