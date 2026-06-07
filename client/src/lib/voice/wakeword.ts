// "Hey Jarvis" wake-word detection via the browser Web Speech API. This runs
// entirely client-side — no audio leaves the browser for wake detection; only
// after the wake phrase (or push-to-talk) do we record + upload for STT.
//
// Web Speech is well-supported in Chrome/Edge desktop and partially on mobile
// Safari. When unavailable, wakeSupported() returns false and the UI falls
// back to space-bar push-to-talk only.

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function wakeSupported(): boolean {
  return getCtor() !== null;
}

// Accept common mis-hearings of "Hey Jarvis" so detection is forgiving.
const WAKE_PATTERNS = [
  /\bhey,?\s+jarvis\b/i,
  /\bhi,?\s+jarvis\b/i,
  /\bok,?\s+jarvis\b/i,
  /\bhey,?\s+travis\b/i,
  /\bjarvis\b/i,
];

function matchesWake(text: string): boolean {
  return WAKE_PATTERNS.some((re) => re.test(text));
}

export interface WakeListener {
  stop: () => void;
}

// Start always-on wake-word listening. `onWake` fires when "Hey Jarvis" is
// heard. The recognizer auto-restarts on end so it stays armed; callers should
// stop() it when entering active recording to avoid double-capture.
export function startWakeWord(onWake: () => void): WakeListener | null {
  const Ctor = getCtor();
  if (!Ctor) return null;

  let stopped = false;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";

  rec.onresult = (ev) => {
    const results = ev.results;
    for (let i = 0; i < results.length; i++) {
      const alt = results[i]?.[0];
      if (alt && matchesWake(alt.transcript)) {
        onWake();
        return;
      }
    }
  };

  rec.onerror = (ev) => {
    // "no-speech" / "aborted" are routine; let onend restart.
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      stopped = true;
    }
  };

  rec.onend = () => {
    if (!stopped) {
      try {
        rec.start();
      } catch {
        /* already starting */
      }
    }
  };

  try {
    rec.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      stopped = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
