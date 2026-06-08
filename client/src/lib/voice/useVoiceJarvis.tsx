import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { startRecording, releaseMic, micSupported, type Recorder } from "./capture";
import { startWakeWord, wakeSupported, type WakeListener } from "./wakeword";
import type { ProcessResult, TierChange, VoiceExchange, VoiceStatus } from "./types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Words that confirm / cancel a pending proposal when spoken or typed.
const CONFIRM_RE = /\b(yes|yeah|yep|do it|confirm|apply|sure|go ahead|sounds good|make it so)\b/i;
const CANCEL_RE = /\b(no|nope|cancel|scratch that|nah|don'?t|leave it|never mind)\b/i;
const UNDO_RE = /\b(undo|revert|undo last|take it back|put it back)\b/i;

interface VoiceContextValue {
  enabled: boolean;
  wakeEnabled: boolean;
  status: VoiceStatus;
  exchanges: VoiceExchange[];
  panelOpen: boolean;
  supported: boolean;
  pendingChanges: TierChange[] | null;
  toggleEnabled: () => void;
  toggleWake: () => void;
  startPushToTalk: () => void;
  stopPushToTalk: () => void;
  confirmPending: () => void;
  discardPending: () => void;
  undoLast: () => void;
  setPanelOpen: (v: boolean) => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [exchanges, setExchanges] = useState<VoiceExchange[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, setPending] = useState<{ conversationId: number; changes: TierChange[] } | null>(
    null,
  );

  const recorderRef = useRef<Recorder | null>(null);
  const wakeRef = useRef<WakeListener | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordingRef = useRef(false);
  // Keep recent turns for the persona so "yeah do it" resolves naturally.
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const pendingRef = useRef<typeof pending>(null);
  pendingRef.current = pending;

  const supported = micSupported();

  // Lazily create the single playback element.
  useEffect(() => {
    const el = new Audio();
    el.addEventListener("ended", () => setStatus("idle"));
    audioRef.current = el;
    return () => {
      el.pause();
      audioRef.current = null;
    };
  }, []);

  const speakUrl = useCallback((url: string) => {
    const el = audioRef.current;
    if (!el) return;
    el.src = url.startsWith("http") ? url : `${API_BASE}${url}`;
    setStatus("speaking");
    el.play().catch(() => setStatus("idle"));
  }, []);

  // ── Confirm / discard / undo ──────────────────────────────────────────────
  const confirmPending = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    try {
      const res = await apiRequest("POST", "/api/voice/confirm", {
        conversationId: p.conversationId,
        changes: p.changes,
      });
      await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      setExchanges((xs) =>
        xs.map((x) => (x.conversationId === p.conversationId ? { ...x, status: "applied" } : x)),
      );
      setPending(null);
    } catch (e) {
      toast({ title: "Couldn't apply that", description: (e as Error).message, variant: "destructive" });
    }
  }, [toast]);

  const discardPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    setExchanges((xs) =>
      xs.map((x) => (x.conversationId === p.conversationId ? { ...x, status: "discarded" } : x)),
    );
    setPending(null);
  }, []);

  const undoLast = useCallback(async () => {
    try {
      const res = await apiRequest("POST", "/api/voice/undo", {});
      const data = (await res.json()) as { reverted: boolean; message?: string };
      if (data.reverted) {
        queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
        queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
        toast({ title: "Reverted", description: "Rolled back the last voice update." });
      } else {
        toast({ title: "Nothing to undo", description: data.message ?? "" });
      }
    } catch (e) {
      toast({ title: "Undo failed", description: (e as Error).message, variant: "destructive" });
    }
  }, [toast]);

  // ── The core observation pipeline ─────────────────────────────────────────
  const handleTranscript = useCallback(
    async (transcript: string) => {
      const clean = transcript.trim();
      if (!clean) {
        setStatus("idle");
        return;
      }

      // If a proposal is pending, treat this utterance as a verbal answer first.
      if (pendingRef.current) {
        if (CONFIRM_RE.test(clean)) {
          setExchanges((xs) => [...xs, mkExchange(clean, "Done — applied.")]);
          await confirmPending();
          setStatus("idle");
          return;
        }
        if (CANCEL_RE.test(clean)) {
          setExchanges((xs) => [...xs, mkExchange(clean, "No problem, leaving it as is.")]);
          discardPending();
          setStatus("idle");
          return;
        }
      }
      if (UNDO_RE.test(clean) && !pendingRef.current) {
        setExchanges((xs) => [...xs, mkExchange(clean, "Rolling that back.")]);
        await undoLast();
        setStatus("idle");
        return;
      }

      // Otherwise it's a fresh observation → run the persona.
      setStatus("thinking");
      try {
        const res = await apiRequest("POST", "/api/voice/process", {
          transcript: clean,
          history: historyRef.current.slice(-6),
        });
        const data = (await res.json()) as ProcessResult;

        historyRef.current.push({ role: "user", content: clean });
        historyRef.current.push({ role: "assistant", content: data.spokenResponse });

        setExchanges((xs) => [
          ...xs,
          {
            id: crypto.randomUUID(),
            conversationId: data.conversationId,
            userTranscript: clean,
            jarvisResponse: data.spokenResponse,
            proposedChanges: data.proposedChanges,
            needsConfirmation: data.needsConfirmation,
            voice: data.voice,
            status: data.needsConfirmation ? "pending" : undefined,
          },
        ]);
        setPanelOpen(true);

        if (data.needsConfirmation && data.proposedChanges.length) {
          setPending({ conversationId: data.conversationId, changes: data.proposedChanges });
        }

        if (data.audioUrl) {
          speakUrl(data.audioUrl);
        } else {
          setStatus("idle");
        }
      } catch (e) {
        toast({ title: "Jarvis hiccup", description: (e as Error).message, variant: "destructive" });
        setStatus("idle");
      }
    },
    [confirmPending, discardPending, undoLast, speakUrl, toast],
  );

  // ── Recording lifecycle ───────────────────────────────────────────────────
  const beginRecording = useCallback(async () => {
    if (recordingRef.current || !supported) return;
    recordingRef.current = true;
    // Pause wake-word listening while we capture so it doesn't fight the mic.
    wakeRef.current?.stop();
    wakeRef.current = null;
    try {
      recorderRef.current = await startRecording();
      setStatus("recording");
    } catch {
      recordingRef.current = false;
      toast({ title: "Mic blocked", description: "Allow microphone access to use voice.", variant: "destructive" });
      setStatus("idle");
    }
  }, [supported, toast]);

  const finishRecording = useCallback(async () => {
    if (!recordingRef.current || !recorderRef.current) return;
    recordingRef.current = false;
    const rec = recorderRef.current;
    recorderRef.current = null;
    try {
      const { blob, mimeType } = await rec.stop();
      setStatus("transcribing");
      const form = new FormData();
      const ext = mimeType.includes("mp4") ? "mp4" : "webm";
      form.append("audio", blob, `clip.${ext}`);
      const res = await fetch(`${API_BASE}/api/voice/transcribe`, { method: "POST", body: form });
      if (!res.ok) throw new Error(`Transcribe failed (${res.status})`);
      const { transcript } = (await res.json()) as { transcript: string };
      await handleTranscript(transcript);
    } catch (e) {
      toast({ title: "Couldn't hear that", description: (e as Error).message, variant: "destructive" });
      setStatus("idle");
    }
  }, [handleTranscript, toast]);

  // ── Wake word arming ──────────────────────────────────────────────────────
  // Re-arm whenever enabled+wakeEnabled and we're back to idle.
  useEffect(() => {
    if (enabled && wakeEnabled && wakeSupported() && status === "idle" && !recordingRef.current) {
      if (!wakeRef.current) {
        wakeRef.current = startWakeWord(() => {
          beginRecording();
          // Auto-stop after a 6s observation window when triggered hands-free.
          window.setTimeout(() => finishRecording(), 6000);
        });
      }
    }
    return () => {
      // cleanup handled on disable below
    };
  }, [enabled, wakeEnabled, status, beginRecording, finishRecording]);

  useEffect(() => {
    if (!enabled || !wakeEnabled) {
      wakeRef.current?.stop();
      wakeRef.current = null;
    }
  }, [enabled, wakeEnabled]);

  // ── Space bar push-to-talk ────────────────────────────────────────────────
  const startPushToTalk = useCallback(() => beginRecording(), [beginRecording]);
  const stopPushToTalk = useCallback(() => finishRecording(), [finishRecording]);

  useEffect(() => {
    if (!enabled) return;
    const isTyping = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    };
    let held = false;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping() || e.repeat) return;
      e.preventDefault();
      held = true;
      beginRecording();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !held) return;
      e.preventDefault();
      held = false;
      finishRecording();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [enabled, beginRecording, finishRecording]);

  // ── Enable / disable ──────────────────────────────────────────────────────
  const toggleEnabled = useCallback(() => {
    setEnabled((on) => {
      const next = !on;
      if (!next) {
        wakeRef.current?.stop();
        wakeRef.current = null;
        releaseMic();
        setWakeEnabled(false);
        setStatus("idle");
      }
      return next;
    });
  }, []);

  const toggleWake = useCallback(() => setWakeEnabled((w) => !w), []);

  return (
    <VoiceContext.Provider
      value={{
        enabled,
        wakeEnabled,
        status,
        exchanges,
        panelOpen,
        supported,
        pendingChanges: pending?.changes ?? null,
        toggleEnabled,
        toggleWake,
        startPushToTalk,
        stopPushToTalk,
        confirmPending,
        discardPending,
        undoLast,
        setPanelOpen,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
}

function mkExchange(user: string, jarvis: string): VoiceExchange {
  return { id: crypto.randomUUID(), userTranscript: user, jarvisResponse: jarvis };
}

export function useVoiceJarvis() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoiceJarvis must be used within VoiceProvider");
  return ctx;
}
