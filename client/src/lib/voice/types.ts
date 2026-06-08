// Shared client-side voice types. Mirrors the server's /api/voice contract.

export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

export interface TierChange {
  raceId: number;
  horsePgm?: string;
  horseName?: string;
  oldTier: Tier;
  newTier: Tier;
  reason: string;
}

// Which booth voice spoke this reply (PR #22). "scarlett" = informational,
// "jarvis" = tier-change action.
export type VoiceName = "scarlett" | "jarvis";

export interface ProcessResult {
  conversationId: number;
  spokenResponse: string;
  proposedChanges: TierChange[];
  needsConfirmation: boolean;
  contextSummary: string | null;
  voice: VoiceName;
  audioUrl: string | null;
}

// One rendered line in the conversation panel.
export interface VoiceExchange {
  id: string;
  conversationId?: number;
  userTranscript: string;
  jarvisResponse: string;
  proposedChanges?: TierChange[];
  needsConfirmation?: boolean;
  voice?: VoiceName;
  status?: "pending" | "applied" | "discarded";
}

export type VoiceStatus =
  | "idle"
  | "listening" // wake-word armed / push-to-talk held
  | "recording"
  | "transcribing"
  | "thinking" // persona LLM working
  | "speaking"; // Jarvis TTS playing
