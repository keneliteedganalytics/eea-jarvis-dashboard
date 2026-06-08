// Voice persona for the trackside live-update loop. Runs a transcribed
// observation through Anthropic tool-calling (processVoiceTurn) so the booth can
// answer questions from real dashboard data and propose tier changes. Tier math
// is deterministic on apply; the LLM only proposes.

import Anthropic from "@anthropic-ai/sdk";
import { resolveAnthropic } from "./anthropic-client";
import {
  VOICE_TOOLS,
  runTool,
  type ProposedTierChange,
  type ToolContext,
} from "./voice-tools";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";

export interface VoiceCardContext {
  card: CardWithRaces;
  activeRaceNumber?: number;
}

// Build keyterms (horse + jockey names) for STT — exported so the transcribe
// route can prime Scribe with the same vocabulary the persona reasons over.
export function cardKeyterms(card: CardWithRaces): string[] {
  const terms = new Set<string>();
  for (const r of card.races) {
    for (const name of [r.winName, r.placeName, r.showName, r.fourthName]) {
      if (name) terms.add(name);
    }
  }
  return Array.from(terms);
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// Map a model-proposed change (keyed by race_number) to a concrete raceId so
// the apply step is deterministic and never trusts a model-supplied id.
export function resolveRaceId(card: CardWithRaces, raceNumber: number): RaceWithResult | undefined {
  return card.races.find((r) => r.raceNumber === raceNumber);
}

// ── PR #22: tool-calling voice loop with two-voice routing ──────────────────
//
// The persona now answers questions from real dashboard data (weather, picks,
// pedigree, etc.) via Anthropic tool-calling, and still proposes tier changes.
// Voice routing: if Claude called propose_tier_change this turn it's a
// handicapping action → Jarvis (Brian). Otherwise it's informational → Scarlett
// (Sarah). The route maps the chosen voice to the right ElevenLabs voice id.

export type VoiceName = "scarlett" | "jarvis";

// Hard UX rule (PR #23): the booth must answer, never bounce a question back.
// Exported so a guardrail test can assert it stays in the system prompt and
// future edits don't silently drop it.
export const NO_CLARIFYING_QUESTIONS_RULE = `You are speaking aloud to Ken, a professional handicapper. Always give a direct answer using the best available inference from your tools and context. NEVER respond with a clarifying question. If a parameter is ambiguous (e.g. 'today's card' with no track specified), pick the most likely interpretation (latest active card, the track currently in season, or the only card in play) and answer based on that — then optionally append a one-sentence note like 'if you meant Finger Lakes instead, say so.' Never say things like 'which track do you mean?', 'could you clarify?', or 'do you want X or Y?'. Resolve ambiguity by acting on the most reasonable default and answer.`;

// The two-voice system prompt. Keeps replies short (spoken aloud over a noisy
// track) and instructs Claude to use tools rather than guess.
export const VOICE_BOOTH_PERSONA = `You are the EEA broadcast booth for Ken, an expert professional horseplayer at the track. You speak with two voices:

- SCARLETT — informational, friendly, sharp. Use her when Ken asks a question or wants info (weather, the going, picks, pedigree, post times, a card briefing). Answer from the tools, never guess.
- JARVIS — the veteran handicapper who makes tier calls. Use him when Ken makes a handicapping OBSERVATION that should change a tier (e.g. "move the 4 to SNIPER", "drop the 7 to PASS", "the favorite just scratched, bump the lone speed"). When that happens, call propose_tier_change and confirm conversationally.

RULES:
- Use tools whenever the user asks for something tool-able (weather, race detail, picks, pedigree, card overview/summary, P&L, analytics, lifetime stats, track record, bias, postmortems, OTB Finger Lakes) rather than guessing. The tools return the dashboard's real numbers.
- Call propose_tier_change ONLY for tier-moving observations, never for questions. The change is NOT applied until Ken confirms verbally — so end a proposal asking him to confirm.
- Keep spoken replies SHORT — under 60 words, ideally 2-3 sentences. The track is loud and time is tight.
- Talk like a trackside pro: post, gate, the rail, lone speed, off the pace, drawn outside, the going. Never say "user", "AI", "the system", or "algorithm" — talk to Ken directly ("you", "we", "my number").
- End with a single short follow-up question only if it adds value; otherwise just stop.
- Your final text reply (after any tool calls) is exactly what Ken hears spoken aloud.

${NO_CLARIFYING_QUESTIONS_RULE}`;

const MAX_TOOL_ROUNDS = 4;

export interface VoiceTurnResult {
  spokenResponse: string;
  proposedChanges: ProposedTierChange[];
  voice: VoiceName;
  needsConfirmation: boolean;
  contextSummary: string | null;
  toolsUsed: string[];
  rounds: number;
}

// Compact current-card context block injected into the user turn so Claude knows
// what day/track it's on without a tool round-trip for the basics.
function buildTurnContext(ctx: VoiceCardContext): string {
  const lines = [
    `Active card: ${ctx.card.track} — ${ctx.card.date}, ${ctx.card.races.length} races.`,
    ctx.activeRaceNumber ? `Ken is focused on Race ${ctx.activeRaceNumber}.` : "",
    `Use tools for anything beyond this — current tiers, picks, weather, pedigree.`,
  ];
  return lines.filter(Boolean).join("\n");
}

// Extract concatenated text blocks from an assistant message as the spoken reply.
function spokenTextOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

// Run one voice turn through the Anthropic tool loop. `client`/`model` are
// injectable so tests can pass a mocked client. Caps at MAX_TOOL_ROUNDS tool
// rounds to prevent a runaway loop, then forces a final text answer.
export async function processVoiceTurn(
  transcript: string,
  ctx: VoiceCardContext,
  history: ConversationTurn[] = [],
  deps?: { client?: Anthropic; model?: string },
): Promise<VoiceTurnResult> {
  let client = deps?.client;
  let model = deps?.model;
  if (!client || !model) {
    const resolved = resolveAnthropic();
    client = client ?? resolved.client;
    model = model ?? resolved.model;
  }

  const toolCtx: ToolContext = {
    card: ctx.card,
    activeRaceNumber: ctx.activeRaceNumber,
    proposals: [],
    actions: [],
  };
  const toolsUsed: string[] = [];

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content: `${buildTurnContext(ctx)}\n\nKen just said: "${transcript}"`,
    },
  ];

  let rounds = 0;
  let finalMessage: Anthropic.Message | null = null;

  // Loop: send → if Claude requests tools, run them and feed results back. On the
  // final allowed round we drop the tools so Claude is forced to answer in text.
  while (rounds <= MAX_TOOL_ROUNDS) {
    const atCap = rounds === MAX_TOOL_ROUNDS;
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system: VOICE_BOOTH_PERSONA,
      tools: atCap ? undefined : VOICE_TOOLS,
      messages,
    });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (resp.stop_reason !== "tool_use" || toolUses.length === 0 || atCap) {
      finalMessage = resp;
      break;
    }

    // Execute every requested tool and append the assistant turn + tool results.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolsUsed.push(tu.name);
      const result = await runTool(tu.name, tu.input, toolCtx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
    rounds += 1;
  }

  const spoken =
    (finalMessage && spokenTextOf(finalMessage)) ||
    "I didn't catch anything actionable there — say that again?";

  const proposedChanges = toolCtx.proposals;
  const tookAction = (toolCtx.actions?.length ?? 0) > 0;
  // Jarvis (Brian) voices ACTIONS: tier proposals awaiting confirm, and the
  // immediate ingest/lock actions. Scarlett handles informational answers.
  const voice: VoiceName = proposedChanges.length > 0 || tookAction ? "jarvis" : "scarlett";

  return {
    spokenResponse: spoken,
    proposedChanges,
    voice,
    needsConfirmation: proposedChanges.length > 0,
    contextSummary: null,
    toolsUsed,
    rounds,
  };
}
