/** WebView entry: mounts the shared UI with the Capacitor host. Owner: coder-2. */
import { App as CapacitorApp } from '@capacitor/app';
import { mountKotoriApp } from '@kotori/ui';
import { createCapacitorPlatformHost } from '../src/index';
import { nativeSpeechPlugin } from '../src/default-deps';
import { installNativeSpeechSynthesis } from '../src/native-tts';

// Android System WebView has no working Web Speech synthesizer: route the UI's
// `speechSynthesis` calls to the native TextToSpeech / online-audio plugin.
const speech = nativeSpeechPlugin();
if (speech) installNativeSpeechSynthesis(speech, window);

const root = document.getElementById('root');
if (root) {
  createCapacitorPlatformHost()
    .then((host) => {
      mountKotoriApp(root, host);
      void CapacitorApp.addListener('backButton', () => {
        const handler = (window as { __kotoriHandleBack?: () => boolean }).__kotoriHandleBack;
        if (handler && !handler()) {
          void CapacitorApp.minimizeApp();
        }
      });
      window.addEventListener('pagehide', () => {
        void host.dispose();
      });
    })
    .catch((error: unknown) => {
      console.error('[kotori:host-android] failed to start', error);
      root.textContent = `Kotori failed to start: ${error instanceof Error ? error.message : String(error)}`;
    });
}
