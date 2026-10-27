/**
 * Web Speech API (`window.speechSynthesis`) Japanese TTS helper.
 * Used for one-click sentence & vocabulary pronunciation in the AI Breakdown
 * panel (especially for manga bubbles where there is no audio track).
 */
export function speakJapanese(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    return false;
  }
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.lang = 'ja-JP';
    utterance.rate = 0.95;
    const voices = synth.getVoices?.() ?? [];
    const jaVoice = voices.find((v) => /^ja([-_]|$)/i.test(v.lang));
    if (jaVoice) utterance.voice = jaVoice;
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
