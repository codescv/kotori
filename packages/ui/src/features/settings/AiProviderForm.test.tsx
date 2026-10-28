import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiSettings } from '@kotori/core';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { useSettingsStore } from '../../stores/settings';
import { useSnackbarStore } from '../../stores/snackbar';
import { DEFAULT_SETTINGS } from '../../app/default-settings';
import { AiProviderForm, draftFromSettings, isValidServiceAccountJson, providerFromDraft, validateAiDraft } from './AiProviderForm';

const VALID_SA = JSON.stringify({ type: 'service_account', client_email: 'kotori@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });

async function setup(opts: Parameters<typeof createMockPlatformHost>[0] = {}): Promise<MockPlatformHost> {
  const host = createMockPlatformHost({ latencyMs: 0, ...opts });
  await useSettingsStore.getState().load(host);
  render(
    <HostProvider host={host}>
      <AiProviderForm />
    </HostProvider>,
  );
  return host;
}

const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

beforeEach(() => {
  useSettingsStore.getState().reset();
  useSnackbarStore.getState().reset();
});
afterEach(() => cleanup());

describe('AiProviderForm — Gemini API key', () => {
  it('shows a validation error for an empty key and does not call testAi', async () => {
    const host = await setup();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('必填')).toBeInTheDocument();
    expect(host.calls.get('settings.testAi')).toBeUndefined();
  });

  it('tests the connection with the unsaved draft and shows success', async () => {
    const host = await setup();
    const spy = vi.spyOn(host.settings, 'testAi');
    type('API Key', 'AIza-test-key');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByTestId('ai-test-result')).toHaveTextContent('连接成功');
    const draft = spy.mock.calls[0]?.[0] as AiSettings;
    expect(draft.provider).toEqual({ provider: 'gemini-api', apiKey: 'AIza-test-key', apiVersion: 'v1beta' });
    // Not persisted until Save.
    expect((await host.settings.get()).ai.provider).toEqual(DEFAULT_SETTINGS.ai.provider);
  });

  it('shows a failure message from the host', async () => {
    await setup();
    type('API Key', 'invalid');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByTestId('ai-test-result')).toHaveTextContent('连接失败');
  });
});

describe('AiProviderForm — Vertex AI', () => {
  it('switching provider shows project / location / auth kinds (ADC available on desktop)', async () => {
    await setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    expect(screen.getByTestId('vertex-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('gemini-fields')).not.toBeInTheDocument();
    expect(screen.getByLabelText('GCP 项目 ID')).toBeInTheDocument();
    expect(screen.getByLabelText('区域（如 us-central1 或 global）')).toHaveValue('global');
    for (const name of ['Access Token', '服务账号 JSON', 'Express API Key', 'ADC（gcloud 默认凭据）']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('hides the ADC option when capabilities.vertexAdc is false', async () => {
    await setup({ capabilities: { vertexAdc: false } });
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    expect(screen.getByRole('radio', { name: 'Access Token' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'ADC（gcloud 默认凭据）' })).not.toBeInTheDocument();
  });

  it('validates service-account JSON (parse + client_email + private_key)', async () => {
    const host = await setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    type('GCP 项目 ID', 'kotori-proj');
    fireEvent.click(screen.getByRole('radio', { name: '服务账号 JSON' }));
    type('服务账号 JSON 内容', '{ "client_email": "x@y" ');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText(/不是有效的服务账号 JSON/)).toBeInTheDocument();
    expect(host.calls.get('settings.testAi')).toBeUndefined();

    type('服务账号 JSON 内容', VALID_SA);
    expect(screen.queryByText(/不是有效的服务账号 JSON/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByTestId('ai-test-result')).toHaveTextContent('连接成功');
  });

  it('express key does not require a project', async () => {
    await setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Express API Key' }));
    expect(screen.getByLabelText('GCP 项目 ID')).toBeDisabled();
    type('Vertex Express API Key', 'AQ.express');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByTestId('ai-test-result')).toHaveTextContent('连接成功');
  });

  it('save replaces the provider object wholesale', async () => {
    const host = await setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    type('GCP 项目 ID', 'kotori-proj');
    type('区域（如 us-central1 或 global）', 'global');
    type('Access Token（gcloud auth print-access-token）', 'fake-access-token');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => expect((await host.settings.get()).ai.provider.provider).toBe('vertex-ai'));
    const saved = (await host.settings.get()).ai;
    expect(saved.provider).toEqual({ provider: 'vertex-ai', project: 'kotori-proj', location: 'global', auth: { kind: 'access-token', accessToken: 'fake-access-token' } });
    expect(saved.provider).not.toHaveProperty('apiKey');
    expect(saved.explainModel).toBe('gemini-3.5-flash-lite');
    expect(useSettingsStore.getState().settings.ai.provider.provider).toBe('vertex-ai');
  });

  it('supports selecting models from dropdown menu, manual input, and editing API timeout', async () => {
    const host = await setup();
    // No duplicate preset chip row: presets live only in the dropdown menu.
    expect(screen.queryByRole('button', { name: 'gemini-3.8-flash' })).toBeNull();
    // Open dropdown menu on explainModel and select gemini-3.8-flash
    fireEvent.click(screen.getByRole('button', { name: '解析模型 options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'gemini-3.8-flash' }));
    expect(screen.getByLabelText('解析模型')).toHaveValue('gemini-3.8-flash');

    // Manual input on visionModel
    type('视觉模型', 'gemini-custom-vision');
    expect(screen.getByLabelText('视觉模型')).toHaveValue('gemini-custom-vision');

    // Edit API timeout (ms)
    type('API 超时时间（ms，≥ 1000）', '45000');
    type('API Key', 'AIza-key');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => expect((await host.settings.get()).ai.timeoutMs).toBe(45000));
    const saved = (await host.settings.get()).ai;
    expect(saved.explainModel).toBe('gemini-3.8-flash');
    expect(saved.visionModel).toBe('gemini-custom-vision');
  });
});

describe('AiProviderForm — pure helpers', () => {
  it('isValidServiceAccountJson', () => {
    expect(isValidServiceAccountJson(VALID_SA)).toBe(true);
    expect(isValidServiceAccountJson('{}')).toBe(false);
    expect(isValidServiceAccountJson('not json')).toBe(false);
    expect(isValidServiceAccountJson(JSON.stringify({ client_email: 'a' }))).toBe(false);
  });

  it('validateAiDraft flags ADC when unavailable, bad thinking budgets, and invalid timeoutMs', () => {
    const base = draftFromSettings(DEFAULT_SETTINGS.ai);
    const d = { ...base, provider: 'vertex-ai' as const, vertex: { ...base.vertex, project: 'p', authKind: 'adc' as const }, thinkingBudget: '-3', timeoutMs: 500 };
    expect(validateAiDraft(d, { vertexAdc: false })).toEqual({
      authKind: 'settings.ai.adcUnavailable',
      thinkingBudget: 'settings.invalidNumber',
      timeoutMs: 'settings.invalidNumber',
    });
    expect(validateAiDraft({ ...d, thinkingBudget: '1024', timeoutMs: 30000 }, { vertexAdc: true })).toEqual({});
  });

  it('providerFromDraft keeps only the selected variant', () => {
    const base = draftFromSettings(DEFAULT_SETTINGS.ai);
    const d = { ...base, provider: 'vertex-ai' as const, gemini: { ...base.gemini, apiKey: 'leak?' }, vertex: { ...base.vertex, authKind: 'express-api-key' as const, expressKey: 'k', project: 'ignored' } };
    expect(providerFromDraft(d)).toEqual({ provider: 'vertex-ai', location: 'global', auth: { kind: 'express-api-key', apiKey: 'k' } });
  });
});
