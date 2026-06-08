// Shared Anthropic client + model resolution for the voice subsystem (PR #22).
//
// Model choice: the voice loop targets Claude Sonnet 4.5. We default to the
// rolling alias `claude-sonnet-4-5` (which the Anthropic SDK resolves to the
// latest Sonnet 4.5 snapshot, currently 2025-09-29) so we automatically pick up
// snapshot bumps without a code change. A pinned id (`claude-sonnet-4-5-20250929`)
// is available in the SDK if reproducibility ever matters. Override order:
//   1. process.env.ANTHROPIC_MODEL   (explicit operator override)
//   2. process.env.VOICE_LLM_MODEL   (legacy voice-specific override)
//   3. settings.defaultAnthropicModel (user setting, seeded to claude-sonnet-4-5)
//   4. DEFAULT_VOICE_MODEL alias below.

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";

export const DEFAULT_VOICE_MODEL = "claude-sonnet-4-5";

export interface AnthropicConfig {
  client: Anthropic;
  model: string;
}

// Resolve the API key from env (preferred) or the saved setting, and the model
// from the override chain above. Throws if no key is configured so the caller
// can surface a clean error rather than a cryptic SDK 401.
export function resolveAnthropic(): AnthropicConfig {
  const s = storage.getSettings();
  const apiKey = process.env.ANTHROPIC_API_KEY || s.anthropicApiKey || "";
  if (!apiKey) {
    throw new Error(
      "Anthropic API key not configured (set ANTHROPIC_API_KEY or save it in Settings)",
    );
  }
  const model =
    process.env.ANTHROPIC_MODEL ||
    process.env.VOICE_LLM_MODEL ||
    s.defaultAnthropicModel ||
    DEFAULT_VOICE_MODEL;
  return { client: new Anthropic({ apiKey }), model };
}
