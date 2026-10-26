/**
 * AI provider settings: Gemini API Key | Vertex AI (segmented), with a Vertex
 * sub-form (project, location, auth kind: access token / service-account JSON
 * / express API key on every host, ADC only when `capabilities.vertexAdc`),
 * model + generation options, a "test connection" round-trip
 * (`settings.testAi(draft)`) and Save (provider object replaced wholesale).
 *
 * The draft keeps both variants side by side so switching back and forth does
 * not lose what the user typed.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AiConnectionTestResult, AiProviderSettings, AiSettings, HostCapabilities, TargetLanguage, VertexAuth } from '@kotori/core';
import { Button } from '../../components/m3/Button';
import { Chip } from '../../components/m3/Chip';
import { IconButton } from '../../components/m3/IconButton';
import { CircularProgress } from '../../components/m3/Progress';
import { SegmentedButton } from '../../components/m3/SegmentedButton';
import { Slider } from '../../components/m3/Slider';
import { Switch } from '../../components/m3/Switch';
import { TextField } from '../../components/m3/TextField';
import { useHost } from '../../host/HostContext';
import { useT, type MessageKey } from '../../i18n';
import { useSettingsStore } from '../../stores/settings';
import { showSnackbar } from '../../stores/snackbar';

export type ProviderKind = AiProviderSettings['provider'];
export type AuthKind = VertexAuth['kind'];

/** Editable form state for both provider variants. */
export interface AiDraft {
  readonly provider: ProviderKind;
  readonly gemini: { readonly apiKey: string; readonly baseUrl: string; readonly apiVersion: 'v1' | 'v1beta' };
  readonly vertex: {
    readonly project: string;
    readonly location: string;
    readonly authKind: AuthKind;
    readonly accessToken: string;
    readonly saJson: string;
    readonly expressKey: string;
    readonly baseUrl: string;
  };
  readonly explainModel: string;
  readonly visionModel: string;
  readonly temperature: number;
  /** Empty string = model default. */
  readonly thinkingBudget: string;
  readonly targetLanguage: TargetLanguage;
  readonly cacheEnabled: boolean;
  readonly timeoutMs: number;
}

export type AiDraftErrors = Partial<Record<'apiKey' | 'project' | 'location' | 'accessToken' | 'saJson' | 'expressKey' | 'explainModel' | 'visionModel' | 'thinkingBudget' | 'authKind', MessageKey>>;

/** Settings → draft (missing variant fields get sensible defaults). */
export function draftFromSettings(ai: AiSettings): AiDraft {
  const p = ai.provider;
  return {
    provider: p.provider,
    gemini: {
      apiKey: p.provider === 'gemini-api' ? p.apiKey : '',
      baseUrl: p.provider === 'gemini-api' ? (p.baseUrl ?? '') : '',
      apiVersion: p.provider === 'gemini-api' ? (p.apiVersion ?? 'v1beta') : 'v1beta',
    },
    vertex: {
      project: p.provider === 'vertex-ai' ? (p.project ?? '') : '',
      location: p.provider === 'vertex-ai' ? p.location : 'us-central1',
      authKind: p.provider === 'vertex-ai' ? p.auth.kind : 'access-token',
      accessToken: p.provider === 'vertex-ai' && p.auth.kind === 'access-token' ? p.auth.accessToken : '',
      saJson: p.provider === 'vertex-ai' && p.auth.kind === 'service-account-json' ? p.auth.json : '',
      expressKey: p.provider === 'vertex-ai' && p.auth.kind === 'express-api-key' ? p.auth.apiKey : '',
      baseUrl: p.provider === 'vertex-ai' ? (p.baseUrl ?? '') : '',
    },
    explainModel: ai.explainModel,
    visionModel: ai.visionModel,
    temperature: ai.temperature,
    thinkingBudget: ai.thinkingBudget === undefined ? '' : String(ai.thinkingBudget),
    targetLanguage: ai.targetLanguage,
    cacheEnabled: ai.cacheEnabled,
    timeoutMs: ai.timeoutMs,
  };
}

/** Check a service-account key: valid JSON object with `client_email` and `private_key`. */
export function isValidServiceAccountJson(json: string): boolean {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null) return false;
    const o = v as Record<string, unknown>;
    return typeof o['client_email'] === 'string' && o['client_email'] !== '' && typeof o['private_key'] === 'string' && o['private_key'] !== '';
  } catch {
    return false;
  }
}

/** Field-level validation for the draft. Empty object = valid. */
export function validateAiDraft(d: AiDraft, caps: Pick<HostCapabilities, 'vertexAdc'>): AiDraftErrors {
  const e: Record<string, MessageKey> = {};
  if (d.provider === 'gemini-api') {
    if (!d.gemini.apiKey.trim()) e['apiKey'] = 'settings.ai.required';
  } else {
    const v = d.vertex;
    if (!v.location.trim()) e['location'] = 'settings.ai.required';
    if (v.authKind !== 'express-api-key' && !v.project.trim()) e['project'] = 'settings.ai.required';
    if (v.authKind === 'access-token' && !v.accessToken.trim()) e['accessToken'] = 'settings.ai.required';
    if (v.authKind === 'service-account-json') {
      if (!v.saJson.trim()) e['saJson'] = 'settings.ai.required';
      else if (!isValidServiceAccountJson(v.saJson)) e['saJson'] = 'settings.ai.invalidJson';
    }
    if (v.authKind === 'express-api-key' && !v.expressKey.trim()) e['expressKey'] = 'settings.ai.required';
    if (v.authKind === 'adc' && !caps.vertexAdc) e['authKind'] = 'settings.ai.adcUnavailable';
  }
  if (!d.explainModel.trim()) e['explainModel'] = 'settings.ai.required';
  if (!d.visionModel.trim()) e['visionModel'] = 'settings.ai.required';
  if (d.thinkingBudget.trim() !== '') {
    const n = Number(d.thinkingBudget);
    if (!Number.isInteger(n) || n < 0) e['thinkingBudget'] = 'settings.invalidNumber';
  }
  return e;
}

/** Draft → `AiProviderSettings` (only the selected variant, no stale fields). */
export function providerFromDraft(d: AiDraft): AiProviderSettings {
  if (d.provider === 'gemini-api') {
    const g = d.gemini;
    return {
      provider: 'gemini-api',
      apiKey: g.apiKey.trim(),
      ...(g.baseUrl.trim() ? { baseUrl: g.baseUrl.trim() } : {}),
      apiVersion: g.apiVersion,
    };
  }
  const v = d.vertex;
  const auth: VertexAuth =
    v.authKind === 'access-token'
      ? { kind: 'access-token', accessToken: v.accessToken.trim() }
      : v.authKind === 'service-account-json'
        ? { kind: 'service-account-json', json: v.saJson.trim() }
        : v.authKind === 'express-api-key'
          ? { kind: 'express-api-key', apiKey: v.expressKey.trim() }
          : { kind: 'adc' };
  return {
    provider: 'vertex-ai',
    ...(v.authKind !== 'express-api-key' && v.project.trim() ? { project: v.project.trim() } : {}),
    location: v.location.trim(),
    auth,
    ...(v.baseUrl.trim() ? { baseUrl: v.baseUrl.trim() } : {}),
  };
}

/** Draft → full `AiSettings`. */
export function aiSettingsFromDraft(d: AiDraft): AiSettings {
  const budget = d.thinkingBudget.trim() === '' ? undefined : Number(d.thinkingBudget);
  return {
    provider: providerFromDraft(d),
    explainModel: d.explainModel.trim(),
    visionModel: d.visionModel.trim(),
    temperature: d.temperature,
    ...(budget !== undefined ? { thinkingBudget: budget } : {}),
    targetLanguage: d.targetLanguage,
    cacheEnabled: d.cacheEnabled,
    timeoutMs: d.timeoutMs,
  };
}

const LANGS: readonly { value: TargetLanguage; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

export const MODEL_PRESETS: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
];

export function AiProviderForm() {
  const host = useHost();
  const t = useT();
  const caps = host.info.capabilities;
  const ai = useSettingsStore((s) => s.settings.ai);
  const loaded = useSettingsStore((s) => s.loaded);
  const update = useSettingsStore((s) => s.update);

  const [draft, setDraft] = useState<AiDraft>(() => draftFromSettings(ai));
  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AiConnectionTestResult | undefined>();

  // Re-sync from the host while the user has not started editing.
  useEffect(() => {
    if (!dirty) setDraft(draftFromSettings(ai));
  }, [ai, loaded, dirty]);

  const errors = useMemo(() => validateAiDraft(draft, caps), [draft, caps]);
  const valid = Object.keys(errors).length === 0;
  const err = (k: keyof AiDraftErrors): string | undefined => {
    const key = errors[k];
    return attempted && key ? t(key) : undefined;
  };

  const edit = (patch: Partial<AiDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setResult(undefined);
  };
  const editGemini = (patch: Partial<AiDraft['gemini']>): void => edit({ gemini: { ...draft.gemini, ...patch } });
  const editVertex = (patch: Partial<AiDraft['vertex']>): void => edit({ vertex: { ...draft.vertex, ...patch } });

  const test = async (): Promise<void> => {
    setAttempted(true);
    if (!valid) return;
    setTesting(true);
    setResult(undefined);
    try {
      setResult(await host.settings.testAi(aiSettingsFromDraft(draft)));
    } catch (e) {
      setResult({ ok: false, model: draft.explainModel, latencyMs: 0, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    setAttempted(true);
    if (!valid) return;
    setSaving(true);
    try {
      const next = aiSettingsFromDraft(draft);
      await update(host, { ai: next });
      setDirty(false);
      setAttempted(false);
      showSnackbar(t('settings.saved'));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    try {
      const { removed } = await host.ai.clearCache();
      showSnackbar(t('settings.ai.cacheCleared', { count: removed }));
    } catch (e) {
      showSnackbar(t('common.error', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' });
    }
  };

  const authKinds: readonly AuthKind[] = caps.vertexAdc ? ['access-token', 'service-account-json', 'express-api-key', 'adc'] : ['access-token', 'service-account-json', 'express-api-key'];
  const secretType = reveal ? 'text' : 'password';
  const revealBtn = <IconButton icon={reveal ? 'visibilityOff' : 'visibility'} label={reveal ? t('settings.ai.hide') : t('settings.ai.reveal')} size="small" onClick={() => setReveal((r) => !r)} />;

  return (
    <form
      className="k-ai-form"
      aria-label={t('settings.section.ai')}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <SegmentedButton<ProviderKind>
        label={t('settings.ai.provider')}
        value={draft.provider}
        onChange={(provider) => edit({ provider })}
        segments={[
          { value: 'gemini-api', label: t('settings.ai.gemini'), icon: 'key' },
          { value: 'vertex-ai', label: t('settings.ai.vertex'), icon: 'cloud' },
        ]}
      />

      {draft.provider === 'gemini-api' ? (
        <div className="k-ai-form__group" data-testid="gemini-fields">
          <TextField
            label={t('settings.ai.apiKey')}
            value={draft.gemini.apiKey}
            type={secretType}
            autoComplete="off"
            onValueChange={(apiKey) => editGemini({ apiKey })}
            supportingText={t('settings.ai.apiKeyHelp')}
            error={err('apiKey')}
            trailing={revealBtn}
          />
          <TextField label={t('settings.ai.baseUrl')} value={draft.gemini.baseUrl} type="url" placeholder="https://generativelanguage.googleapis.com" onValueChange={(baseUrl) => editGemini({ baseUrl })} />
          <div className="k-ai-form__inline">
            <span className="k-label-large">{t('settings.ai.apiVersion')}</span>
            <SegmentedButton<'v1' | 'v1beta'>
              dense
              label={t('settings.ai.apiVersion')}
              value={draft.gemini.apiVersion}
              onChange={(apiVersion) => editGemini({ apiVersion })}
              segments={[
                { value: 'v1beta', label: 'v1beta' },
                { value: 'v1', label: 'v1' },
              ]}
            />
          </div>
        </div>
      ) : (
        <div className="k-ai-form__group" data-testid="vertex-fields">
          <div className="k-ai-form__row">
            <TextField
              label={t('settings.ai.project')}
              value={draft.vertex.project}
              disabled={draft.vertex.authKind === 'express-api-key'}
              onValueChange={(project) => editVertex({ project })}
              error={err('project')}
              supportingText={draft.vertex.authKind === 'express-api-key' ? t('settings.ai.expressHelp') : undefined}
            />
            <TextField label={t('settings.ai.location')} value={draft.vertex.location} onValueChange={(location) => editVertex({ location })} error={err('location')} />
          </div>
          <div className="k-ai-form__auth">
            <span className="k-label-large">{t('settings.ai.authKind')}</span>
            <SegmentedButton<AuthKind>
              dense
              className="k-ai-form__auth-kinds"
              label={t('settings.ai.authKind')}
              value={draft.vertex.authKind}
              onChange={(authKind) => editVertex({ authKind })}
              segments={authKinds.map((k) => ({ value: k, label: t(`settings.ai.auth.${k}`) }))}
            />
            {err('authKind') && <p className="k-error-text">{err('authKind')}</p>}
          </div>
          {draft.vertex.authKind === 'access-token' && (
            <TextField label={t('settings.ai.accessToken')} value={draft.vertex.accessToken} type={secretType} autoComplete="off" onValueChange={(accessToken) => editVertex({ accessToken })} error={err('accessToken')} trailing={revealBtn} />
          )}
          {draft.vertex.authKind === 'service-account-json' && (
            <TextField
              multiline
              rows={6}
              label={t('settings.ai.saJson')}
              value={draft.vertex.saJson}
              spellCheck={false}
              onValueChange={(saJson) => editVertex({ saJson })}
              supportingText={t('settings.ai.saJsonHelp')}
              error={err('saJson')}
            />
          )}
          {draft.vertex.authKind === 'express-api-key' && (
            <TextField label={t('settings.ai.expressKey')} value={draft.vertex.expressKey} type={secretType} autoComplete="off" onValueChange={(expressKey) => editVertex({ expressKey })} error={err('expressKey')} trailing={revealBtn} />
          )}
          {draft.vertex.authKind === 'adc' && <p className="k-muted k-body-medium">{t('settings.ai.adcHelp')}</p>}
        </div>
      )}

      <div className="k-ai-form__group">
        <h3 className="k-title-small k-muted">{t('settings.ai.models')}</h3>
        <div className="k-ai-form__row">
          <TextField label={t('settings.ai.explainModel')} list="k-ai-model-presets" value={draft.explainModel} onValueChange={(explainModel) => edit({ explainModel })} error={err('explainModel')} />
          <TextField label={t('settings.ai.visionModel')} list="k-ai-model-presets" value={draft.visionModel} onValueChange={(visionModel) => edit({ visionModel })} error={err('visionModel')} />
        </div>
        <datalist id="k-ai-model-presets">
          {MODEL_PRESETS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="k-ai-form__inline" style={{ flexWrap: 'wrap', gap: 8 }}>
          {MODEL_PRESETS.map((m) => (
            <Chip
              key={m}
              kind="filter"
              selected={draft.explainModel === m && draft.visionModel === m}
              onClick={() => edit({ explainModel: m, visionModel: m })}
            >
              {m}
            </Chip>
          ))}
        </div>
        <div className="k-ai-form__inline">
          <span className="k-label-large">{t('settings.ai.targetLanguage')}</span>
          <SegmentedButton<TargetLanguage> dense label={t('settings.ai.targetLanguage')} value={draft.targetLanguage} onChange={(targetLanguage) => edit({ targetLanguage })} segments={LANGS} />
        </div>
        <Slider label={t('settings.ai.temperature')} value={draft.temperature} min={0} max={2} step={0.1} format={(v) => v.toFixed(1)} onChange={(temperature) => edit({ temperature })} />
        <TextField label={t('settings.ai.thinking')} value={draft.thinkingBudget} type="number" min={0} inputMode="numeric" onValueChange={(thinkingBudget) => edit({ thinkingBudget })} error={err('thinkingBudget')} />
        <div className="k-ai-form__inline">
          <Switch label={t('settings.ai.cache')} checked={draft.cacheEnabled} onChange={(cacheEnabled) => edit({ cacheEnabled })} />
          <Button variant="text" icon="delete" onClick={() => void clearCache()}>
            {t('settings.ai.clearCache')}
          </Button>
        </div>
      </div>

      {result && (
        <p className={result.ok ? 'k-ai-form__result is-ok' : 'k-ai-form__result is-fail'} role="status" data-testid="ai-test-result">
          {result.ok ? t('settings.ai.testOk', { model: result.model, ms: Math.round(result.latencyMs) }) : t('settings.ai.testFail', { message: result.message })}
        </p>
      )}

      <div className="k-ai-form__actions">
        {dirty && <span className="k-muted k-body-small">{t('settings.ai.dirty')}</span>}
        <span className="k-spacer" />
        {dirty && (
          <Button
            variant="text"
            onClick={() => {
              setDraft(draftFromSettings(ai));
              setDirty(false);
              setAttempted(false);
              setResult(undefined);
            }}
          >
            {t('settings.ai.reset')}
          </Button>
        )}
        <Button variant="outlined" {...(testing ? {} : { icon: 'sparkle' as const })} disabled={testing} onClick={() => void test()}>
          {testing ? (
            <span className="k-row">
              <CircularProgress size={18} /> {t('settings.ai.testing')}
            </span>
          ) : (
            t('settings.ai.test')
          )}
        </Button>
        <Button type="submit" icon="check" disabled={saving || !dirty}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
