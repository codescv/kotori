/**
 * Vertex AI Application Default Credentials for the desktop host (ADC only;
 * access-token / service-account JSON / express key are resolved in core).
 * `google-auth-library` is pure JS (no native addons).
 */
import { KotoriError } from '@kotori/core';
import { GoogleAuth } from 'google-auth-library';

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Minimal surface of `GoogleAuth` we use (injectable for tests). */
export interface AdcClientFactory {
  getAccessToken(): Promise<string | null | undefined>;
}

/**
 * Returns a token provider backed by ADC (gcloud user creds,
 * `GOOGLE_APPLICATION_CREDENTIALS`, or the metadata server). The library
 * caches/refreshes tokens internally. Errors map to `ai-auth`.
 */
export function adcTokenProvider(factory?: AdcClientFactory): () => Promise<string> {
  let auth: AdcClientFactory | undefined = factory;
  return async () => {
    try {
      auth ??= new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
      const token = await auth.getAccessToken();
      if (!token) throw new Error('empty access token');
      return token;
    } catch (error) {
      throw new KotoriError(
        'ai-auth',
        `Application Default Credentials unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`gcloud auth application-default login\`.`,
        { cause: error },
      );
    }
  };
}
