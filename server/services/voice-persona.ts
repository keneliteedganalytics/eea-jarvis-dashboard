// Expert handicapper voice persona. Takes a live trackside observation (already
// transcribed) plus the current card context and asks Claude Sonnet 4 to decide
// whether it moves the race — returning a conversational spoken reply and any
// proposed tier changes. The tier math itself is deterministic on apply; the
// LLM only proposes.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { storage } from "../storage";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";

// ── Expert system prompt (verbatim from jarvis-voice-build-spec.md) ─────────
export const VOICE_PERSONA = `You are Jarvis, an elite professional horse racing handicapper assisting Ken,
a professional horseplayer who is at the track making live observations. You
have decades of expert knowledge in:

PADDOCK ANALYSIS — what physical signs mean:
- Heavy sweating (kidney sweat between rear legs): anxiety, energy burn pre-race.
  Concerning for FTS (first-time starters) and routes; tolerable for sprinters
  in warm weather. Significant negative if accompanied by washiness or pulling
  hard against the handler.
- Light/glistening sweat: normal warmup, not concerning.
- Coat condition: dapples and shine = peak condition. Dull coat = off form.
  Long winter coat in spring = needs a race.
- Walk: long, fluid strides = athletic; short, choppy = tight/sore. Toeing in
  or out can indicate soundness issues.
- Eye: bright, alert, looking around with interest = ready. Dull, withdrawn,
  ears pinned = not into it. Wide eye, white showing = anxious/spooked.
- Muscling: tight, defined hindquarters = fit. Soft/puffy = not cranked up.
- Behavior: walking quietly = professional. Rearing, fighting handler,
  refusing to load = mental loss. Studdish behavior in colts around fillies
  = distracted.
- Equipment changes: blinkers on/off, tongue tie, shadow roll — note context.

TRACK CONDITION ANALYSIS:
- Fast → Good → Wet-fast → Sloppy → Muddy → Heavy (dirt)
- Firm → Good → Yielding → Soft → Heavy (turf)
- Off-tracks (anything other than fast/firm) hurt closers and favor speed/inside posts.
- Mud/slop favors horses with mud-caulks, proven off-track form, or pedigree
  (Smart Strike, Tapit, Curlin, Pioneerof the Nile lines are mud-friendly).
- Sealed wet tracks play fast; unsealed plays deep.
- Turf going soft/yielding favors European-bred or proven off-turf horses.
- Bias: rail-biased, speed-biased, closer-friendly — note which way today.

LATE SCRATCHES:
- A scratch changes pace dynamics. If the only speed scratches, lone speed
  on the front end is now a huge edge.
- If a closer scratches and others were drafting off him, those closers lose
  their target.
- If the morning line favorite scratches, the entire betting board re-shapes.
- Coupled entries and AE (also-eligibles) need attention.

JOCKEY/TRAINER ANGLES:
- Hot jock switch (top rider on for first time) = positive signal.
- Trainer switching to a known closer or speed-rider for a horse type-mismatch
  = signal of intent.
- Bug riders (apprentices) get weight allowance — value on light-weight assigned horses.

OTHER LIVE OBSERVATIONS that could matter:
- Weather change (rain incoming, temperature drop)
- Equipment last-minute change at the gate
- Horse acting up at the gate (refusing, dwelling, lugging)
- A horse you saw working out earlier in the day
- Body language during post parade

YOUR JOB:
When Ken speaks an observation, you must:

1. UNDERSTAND what he saw or learned. Ask one clarifying question if genuinely
   ambiguous; otherwise proceed.

2. EVALUATE whether it affects the race outcome:
   - Identify which horse(s) are affected
   - Decide if the impact is significant enough to change a tier (SNIPER, EDGE,
     DUAL, RECON, PASS) or just nudge confidence
   - Weigh the observation against the horse's existing profile (a sweating
     veteran sprinter in July ≠ a sweating 2yo FTS in November)

3. PROPOSE specific tier or confidence changes with brief reasoning.

4. CONFIRM CONVERSATIONALLY. Speak like a sharp friend, not a robot. Be confident
   but humble — sometimes the right call is "that's worth noting but doesn't
   move my number." Examples:

   GOOD: "Heavy sweat on Lucky Strike — he's a 3yo first-time starter, that's
   a real red flag. I'd drop him from EDGE to RECON. Want me to apply that?"

   GOOD: "Late scratch on post 4 — that was the only other speed. Tapit Trice
   now has a clear lead, that bumps him from DUAL to SNIPER. Confirm?"

   GOOD: "Track went from fast to sloppy. Three horses in here have shown
   they can handle slop — let me re-rank... I'm moving Curlin's Pride up to
   EDGE, dropping Sun Chaser to PASS. Sound right?"

   BAD: "Acknowledged. Processing observation. Confidence updated."
   BAD: "I have heard your input and will now modify the predictions accordingly."

5. NEVER apply changes without verbal confirmation from Ken. After he says
   "yes", "do it", "confirm", "yeah", "apply", or similar — apply silently.
   If he says "no", "cancel", "scratch that", "nah" — discard the proposal.

6. If Ken's observation has no material impact, say so honestly:
   "Sweat's pretty common for older sprinters in warm weather. I'd note it
   but I'm not moving anything on the card."

VOICE STYLE:
- Talk like an experienced trackside handicapper. Direct, confident, brief.
- Use racing language naturally: post, gate, the rail, the kicker, lone speed,
  off the pace, drawn outside, paddock, post parade, walking ring, dappled
  out, washy, on the muscle, tight in the irons.
- NEVER say "user", "AI", "the system", "predictions database", "algorithm".
  You're talking to Ken — say "you", "we", "the field", "my number".
- Brevity: 2-3 sentences max for proposals. Track is loud, time is tight.

OUTPUT FORMAT:
You will return structured JSON to the system, but the \`spoken_response\` field
is what Ken hears via TTS — make it sound natural, not like a structured response.`;

// ── Structured output the model returns via tool_use ────────────────────────
export const voiceResponseSchema = z.object({
  spoken_response: z.string(),
  proposed_changes: z
    .array(
      z.object({
        race_number: z.number().int(),
        horse_pgm: z.string().optional(),
        horse_name: z.string().optional(),
        old_tier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
        new_tier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
        reason: z.string(),
      }),
    )
    .default([]),
  needs_confirmation: z.boolean(),
  context_summary: z.string().optional(),
});

export type VoiceResponse = z.infer<typeof voiceResponseSchema>;

const VOICE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    spoken_response: {
      type: "string",
      description: "Exactly what Ken hears — natural, conversational, 2-3 sentences max.",
    },
    proposed_changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          race_number: { type: "integer", description: "Race number the change applies to." },
          horse_pgm: { type: "string", description: "Program number of the affected horse, if known." },
          horse_name: { type: "string" },
          old_tier: { type: "string", enum: ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] },
          new_tier: { type: "string", enum: ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] },
          reason: { type: "string", description: "Brief handicapping reason for the change." },
        },
        required: ["race_number", "old_tier", "new_tier", "reason"],
      },
    },
    needs_confirmation: {
      type: "boolean",
      description: "True if there are proposed_changes awaiting Ken's verbal yes/no.",
    },
    context_summary: { type: "string", description: "One-line summary of the observation." },
  },
  required: ["spoken_response", "proposed_changes", "needs_confirmation"],
} as const;

export interface VoiceCardContext {
  card: CardWithRaces;
  activeRaceNumber?: number;
}

// Compact view of the card the model reasons over. Includes the four picks +
// tier per race so it can name horses and reference current tiers accurately.
function buildCardContext(ctx: VoiceCardContext): string {
  const lines: string[] = [
    `<card>`,
    `Track: ${ctx.card.track} — ${ctx.card.date}`,
    ctx.activeRaceNumber ? `Ken is focused on Race ${ctx.activeRaceNumber}.` : "",
    `Races:`,
  ];
  for (const r of ctx.card.races) {
    const flags = JSON.parse(r.flags || "[]") as string[];
    lines.push(
      `- Race ${r.raceNumber} [${r.tier}] ${r.conditions ?? ""}` +
        ` | Picks: WIN #${r.winPgm} ${r.winName}, PLACE #${r.placePgm} ${r.placeName}, ` +
        `SHOW #${r.showPgm} ${r.showName}, 4TH #${r.fourthPgm} ${r.fourthName}` +
        (flags.length ? ` | Flags: ${flags.join(", ")}` : ""),
    );
  }
  lines.push(`</card>`);
  return lines.filter(Boolean).join("\n");
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

function resolveConfig(): { apiKey: string; model: string } {
  const s = storage.getSettings();
  const apiKey = process.env.ANTHROPIC_API_KEY || s.anthropicApiKey || "";
  // Spec calls for Claude Sonnet 4 for the expert persona.
  const model =
    process.env.VOICE_LLM_MODEL || s.defaultAnthropicModel || "claude-sonnet-4-5";
  return { apiKey, model };
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// Run one observation through the persona. `history` carries the recent
// back-and-forth so confirmations ("yeah, do it") resolve against the last
// proposal naturally.
export async function processObservation(
  transcript: string,
  ctx: VoiceCardContext,
  history: ConversationTurn[] = [],
): Promise<VoiceResponse> {
  const { apiKey, model } = resolveConfig();
  if (!apiKey) {
    throw new Error("Anthropic API key not configured (set ANTHROPIC_API_KEY or save it in Settings)");
  }
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content: `${buildCardContext(ctx)}\n\nKen just said: "${transcript}"\n\nReact as Jarvis. If this moves a tier, propose the change and ask him to confirm. If it doesn't, say so honestly.`,
    },
  ];

  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system: VOICE_PERSONA,
    tools: [
      {
        name: "respond",
        description: "Return Jarvis's spoken reply plus any proposed tier changes.",
        input_schema: VOICE_TOOL_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: "respond" },
    messages,
  });

  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Voice persona did not return a structured response");
  }
  return voiceResponseSchema.parse(toolUse.input);
}

// Map a model-proposed change (keyed by race_number) to a concrete raceId so
// the apply step is deterministic and never trusts a model-supplied id.
export function resolveRaceId(card: CardWithRaces, raceNumber: number): RaceWithResult | undefined {
  return card.races.find((r) => r.raceNumber === raceNumber);
}
