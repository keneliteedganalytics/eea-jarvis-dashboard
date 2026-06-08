// Anthropic tool definitions + server-side handlers for the voice loop (PR #22).
//
// Each tool gives Claude read access to the dashboard's own data so the voice
// persona answers from real numbers instead of guessing. Handlers resolve the
// active card from the same helper the voice router uses, return structured
// JSON, and NEVER throw — any failure resolves to `{ error: string }` so Claude
// can recover and explain rather than crashing the turn.
//
// `propose_tier_change` is special: it produces the SAME proposal shape the old
// processObservation returned, which the existing /confirm flow applies. The
// tool loop records each propose_tier_change call so the route can surface the
// structured proposedChanges array and route the reply to the Jarvis voice.

import Anthropic from "@anthropic-ai/sdk";
import { getRaceWeather } from "./weather";
import { computeBloodstockFitness } from "../bloodstock";
import { DEFAULT_WEIGHTS } from "./eea-config";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import type { RaceConditions } from "./parsers/types";

const TIERS = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;
export type Tier = (typeof TIERS)[number];

// A proposal recorded when Claude calls propose_tier_change. Mirrors the
// race_number-keyed shape the route resolves to a concrete raceId.
export interface ProposedTierChange {
  race_number: number;
  horse_pgm?: string;
  horse_name?: string;
  old_tier: Tier;
  new_tier: Tier;
  reason: string;
}

// Per-turn execution context handed to each handler.
export interface ToolContext {
  card: CardWithRaces;
  activeRaceNumber?: number;
  // Collected side effect: every propose_tier_change call appends here.
  proposals: ProposedTierChange[];
}

type ToolResult = Record<string, unknown> | { error: string };

// ── Tool input schemas (strict JSON Schema) ─────────────────────────────────
export const VOICE_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_track_weather",
    description:
      "Get the current/forecast weather + derived track-surface impact for a race. " +
      "Use when the user asks about weather, rain, the going, or whether the track is off.",
    input_schema: {
      type: "object",
      properties: {
        trackCode: {
          type: "string",
          description: "Track code or name. Defaults to the active card's track if omitted.",
        },
        raceNumber: {
          type: "integer",
          description: "Race number. Defaults to the nearest upcoming race if omitted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_card_overview",
    description:
      "Get the active card: track, date, race count, and per-race tier + post time. " +
      "Use for a quick read of the whole day.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_race_details",
    description:
      "Get full detail for one race: distance, surface, post time, conditions, tier, " +
      "the four picks with program numbers, and any flags.",
    input_schema: {
      type: "object",
      properties: {
        raceNumber: { type: "integer", description: "Race number to detail." },
      },
      required: ["raceNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "get_top_picks",
    description:
      "Get the day's strongest plays across the card (the win pick per race), " +
      "optionally filtered to one or more tiers (e.g. SNIPER, EDGE).",
    input_schema: {
      type: "object",
      properties: {
        tier: {
          type: "array",
          items: { type: "string", enum: TIERS as unknown as string[] },
          description: "Filter to these tiers. Omit for all non-PASS plays.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_horse_pedigree",
    description:
      "Get a horse's sire/dam/dam-sire and the bloodstock fitness composite (surface, " +
      "distance, wet aptitude) for its race. Use for pedigree / breeding questions.",
    input_schema: {
      type: "object",
      properties: {
        raceNumber: { type: "integer", description: "Race the horse runs in." },
        horsePgm: { type: "string", description: "Program (saddlecloth) number of the horse." },
      },
      required: ["raceNumber", "horsePgm"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_tier_change",
    description:
      "Propose moving a horse to a new tier. Call ONLY when the user makes a handicapping " +
      "observation that should change a tier (e.g. 'bump the 4 to SNIPER', 'drop the 7 to " +
      "PASS'). Do NOT call for questions. The change is NOT applied here — it returns a " +
      "proposal Ken confirms verbally.",
    input_schema: {
      type: "object",
      properties: {
        raceNumber: { type: "integer", description: "Race number the change applies to." },
        horsePgm: { type: "string", description: "Program number of the affected horse." },
        horseName: { type: "string", description: "Name of the affected horse (if pgm unknown)." },
        newTier: { type: "string", enum: TIERS as unknown as string[], description: "Target tier." },
        reason: { type: "string", description: "Brief handicapping reason for the change." },
      },
      required: ["raceNumber", "newTier", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "summarize_card",
    description:
      "Get a compact structured briefing of the whole card (track, date, headline plays, " +
      "tier counts) to synthesize a 2-3 sentence spoken summary. Use for 'give me the briefing'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function findRace(card: CardWithRaces, raceNumber: number): RaceWithResult | undefined {
  return card.races.find((r) => r.raceNumber === raceNumber);
}

// Pick the nearest upcoming race by post_time_utc; fall back to the active race
// or the first race when post times are missing.
function nearestUpcomingRace(card: CardWithRaces, activeRaceNumber?: number): RaceWithResult | undefined {
  if (activeRaceNumber) {
    const r = findRace(card, activeRaceNumber);
    if (r) return r;
  }
  const now = Date.now();
  const withPost = card.races
    .filter((r) => r.postTimeUtc)
    .map((r) => ({ r, t: new Date(r.postTimeUtc as string).getTime() }))
    .filter((x) => !Number.isNaN(x.t));
  const upcoming = withPost.filter((x) => x.t >= now).sort((a, b) => a.t - b.t);
  if (upcoming.length) return upcoming[0].r;
  if (withPost.length) return withPost.sort((a, b) => a.t - b.t)[0].r;
  return card.races[0];
}

function raceConditions(r: RaceWithResult): RaceConditions {
  // The race row stores a free-text conditions string + flattened distance/
  // surface is not separated, so parse what we can for the bloodstock scorer.
  const raw = r.conditions ?? "";
  const surfaceMatch = /turf/i.test(raw) ? "TURF" : /dirt|main/i.test(raw) ? "DIRT" : "";
  const distMatch = raw.match(/(\d+(?:\s*\d?\/?\d?)?\s*(?:F|M|MILE|YARDS?))/i);
  return {
    type: "",
    raw,
    purse: 0,
    distance: distMatch?.[1] ?? "",
    surface: surfaceMatch,
  } as RaceConditions;
}

function picks(r: RaceWithResult) {
  return {
    win: { pgm: r.winPgm, name: r.winName },
    place: { pgm: r.placePgm, name: r.placeName },
    show: { pgm: r.showPgm, name: r.showName },
    fourth: { pgm: r.fourthPgm, name: r.fourthName },
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────
export async function getTrackWeather(
  input: { trackCode?: string; raceNumber?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const track = input.trackCode || ctx.card.track;
    const race =
      input.raceNumber != null
        ? findRace(ctx.card, input.raceNumber)
        : nearestUpcomingRace(ctx.card, ctx.activeRaceNumber);
    if (!race) return { error: "No race found to fetch weather for." };
    const postTimeUtc = race.postTimeUtc || new Date().toISOString();
    const w = await getRaceWeather(track, postTimeUtc);
    return {
      raceNumber: race.raceNumber,
      track,
      tempF: w.tempF,
      feelsLikeF: w.feelsLikeF,
      conditions: w.conditions,
      surfaceImpact: w.surfaceImpact,
      windMph: w.windMph,
      precipMm: w.precipMm,
      fetchedAt: w.fetchedAt,
    };
  } catch (e) {
    return { error: `Weather lookup failed: ${(e as Error).message}` };
  }
}

export function getCardOverview(_input: unknown, ctx: ToolContext): ToolResult {
  try {
    return {
      track: ctx.card.track,
      date: ctx.card.date,
      raceCount: ctx.card.races.length,
      activeRaceNumber: ctx.activeRaceNumber ?? null,
      races: ctx.card.races.map((r) => ({
        raceNumber: r.raceNumber,
        tier: r.tier,
        post: r.post,
        conditions: r.conditions,
      })),
    };
  } catch (e) {
    return { error: `Card overview failed: ${(e as Error).message}` };
  }
}

export function getRaceDetails(input: { raceNumber: number }, ctx: ToolContext): ToolResult {
  try {
    const r = findRace(ctx.card, input.raceNumber);
    if (!r) return { error: `Race ${input.raceNumber} is not on the card.` };
    const flags = JSON.parse(r.flags || "[]") as string[];
    return {
      raceNumber: r.raceNumber,
      tier: r.tier,
      post: r.post,
      postTimeUtc: r.postTimeUtc,
      conditions: r.conditions,
      shape: r.shape,
      picks: picks(r),
      flags,
      surfaceImpact: r.weather?.surfaceImpact ?? null,
    };
  } catch (e) {
    return { error: `Race details failed: ${(e as Error).message}` };
  }
}

export function getTopPicks(input: { tier?: string[] }, ctx: ToolContext): ToolResult {
  try {
    const filter = input.tier && input.tier.length ? new Set(input.tier) : null;
    const plays = ctx.card.races
      .filter((r) => (filter ? filter.has(r.tier) : r.tier !== "PASS"))
      .map((r) => ({
        raceNumber: r.raceNumber,
        tier: r.tier,
        winPgm: r.winPgm,
        winName: r.winName,
        post: r.post,
      }));
    return { count: plays.length, plays };
  } catch (e) {
    return { error: `Top picks failed: ${(e as Error).message}` };
  }
}

export function getHorsePedigree(
  input: { raceNumber: number; horsePgm: string },
  ctx: ToolContext,
): ToolResult {
  try {
    const r = findRace(ctx.card, input.raceNumber);
    if (!r) return { error: `Race ${input.raceNumber} is not on the card.` };
    const summary = r.pedigree?.[input.horsePgm];
    if (!summary) {
      return { error: `No pedigree on file for #${input.horsePgm} in race ${input.raceNumber}.` };
    }
    // Recompute the full fitness breakdown from the persisted names so we can
    // surface surface/distance/wet sub-fits, not just the stored composite.
    const fitness = computeBloodstockFitness(
      {
        sireName: summary.sireName,
        damName: summary.damName,
        damSireName: summary.damSireName,
      },
      {
        conditions: raceConditions(r),
        surfaceWet: ["wet", "sloppy", "muddy"].includes(r.weather?.surfaceImpact ?? ""),
      },
      DEFAULT_WEIGHTS.bloodstock,
    );
    return {
      raceNumber: r.raceNumber,
      horsePgm: input.horsePgm,
      sire: summary.sireName,
      dam: summary.damName,
      damSire: summary.damSireName,
      composite: fitness.composite,
      surfaceFit: fitness.surfaceFit,
      distanceFit: fitness.distanceFit,
      wetFit: fitness.wetFit,
      confidence: fitness.confidence,
      reasonCodes: fitness.reasonCodes,
    };
  } catch (e) {
    return { error: `Pedigree lookup failed: ${(e as Error).message}` };
  }
}

export function proposeTierChange(
  input: { raceNumber: number; horsePgm?: string; horseName?: string; newTier: string; reason: string },
  ctx: ToolContext,
): ToolResult {
  try {
    const r = findRace(ctx.card, input.raceNumber);
    if (!r) return { error: `Race ${input.raceNumber} is not on the card.` };
    if (!(TIERS as readonly string[]).includes(input.newTier)) {
      return { error: `Unknown tier "${input.newTier}".` };
    }
    const proposal: ProposedTierChange = {
      race_number: input.raceNumber,
      horse_pgm: input.horsePgm,
      horse_name: input.horseName,
      old_tier: r.tier as Tier,
      new_tier: input.newTier as Tier,
      reason: input.reason,
    };
    ctx.proposals.push(proposal);
    return {
      ok: true,
      proposed: proposal,
      note: "Proposal recorded — awaits Ken's verbal confirmation before it is applied.",
    };
  } catch (e) {
    return { error: `Proposal failed: ${(e as Error).message}` };
  }
}

export function summarizeCard(_input: unknown, ctx: ToolContext): ToolResult {
  try {
    const tierCounts: Record<string, number> = {};
    for (const r of ctx.card.races) tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
    const headline = ctx.card.races
      .filter((r) => r.tier === "SNIPER" || r.tier === "EDGE")
      .map((r) => ({ raceNumber: r.raceNumber, tier: r.tier, winPgm: r.winPgm, winName: r.winName }));
    return {
      track: ctx.card.track,
      date: ctx.card.date,
      raceCount: ctx.card.races.length,
      tierCounts,
      headlinePlays: headline,
    };
  } catch (e) {
    return { error: `Summary failed: ${(e as Error).message}` };
  }
}

// Dispatch a tool_use block to its handler. Unknown tools resolve to an error
// result rather than throwing so the loop can continue.
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "get_track_weather":
      return getTrackWeather(i as { trackCode?: string; raceNumber?: number }, ctx);
    case "get_card_overview":
      return getCardOverview(i, ctx);
    case "get_race_details":
      return getRaceDetails(i as { raceNumber: number }, ctx);
    case "get_top_picks":
      return getTopPicks(i as { tier?: string[] }, ctx);
    case "get_horse_pedigree":
      return getHorsePedigree(i as { raceNumber: number; horsePgm: string }, ctx);
    case "propose_tier_change":
      return proposeTierChange(
        i as { raceNumber: number; horsePgm?: string; horseName?: string; newTier: string; reason: string },
        ctx,
      );
    case "summarize_card":
      return summarizeCard(i, ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
