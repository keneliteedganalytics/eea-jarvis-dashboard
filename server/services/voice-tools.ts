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
import { storage } from "../storage";
import {
  buildAnalyticsSummary,
  buildLifetimeStats,
  buildTrackRecordSummary,
} from "../analytics";
import { getOrFetchBias } from "./bias-fetcher";
import { fetchOtbFingerLakes } from "./otb-finger-lakes";
import { runOnDemandIngest } from "./on-demand-ingest";
import {
  runDeepPostmortem,
  runDeepPostmortemToday,
  getDeepPostmortem,
} from "./deep-postmortem";
import { runFusionReplay, runFusionReplayToday } from "./fusion-replay";
import type {
  CardWithRaces,
  RaceWithResult,
  DeepPostmortem,
  FusionReplay,
} from "@shared/schema";
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
  // Action tools (ingest_card_for_review, lock_card) append their tool name
  // here so the router can route the reply to the Jarvis voice — same intent as
  // proposals[], but these actions take effect immediately (no confirm step).
  actions?: string[];
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
  // ── PR #23: comprehensive dashboard Q&A tools ──────────────────────────────
  {
    name: "get_pnl_today",
    description:
      "Today's profit & loss: flat-bet units won/lost today, ROI%, races graded today, and " +
      "races still pending today. Use for 'how much have we made today', 'are we up or down', " +
      "'what's our P&L'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_lifetime_stats",
    description:
      "Lifetime scorecard across every card ever loaded: total cards/races/graded, win/place/" +
      "show/ITM/exacta/tri/super hit rates, flag accuracy, and a per-track breakdown. Use for " +
      "'lifetime hit rate', 'how are we doing at Finger Lakes overall'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_analytics_summary",
    description:
      "Performance analytics scoped to today, a specific track all-time, or lifetime. " +
      "Returns graded races, average win%, ITM%, ROI%, best tier, per-tier hit rates, flag " +
      "accuracy, and race-type performance. Use scope='today' for 'how are we doing today' / " +
      "'what's our ROI today', scope='track' with a track name for 'how do we do at Saratoga', " +
      "scope='lifetime' for 'what's our lifetime hit rate' or 'how do we do overall'.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["today", "track", "lifetime"],
          description: "today = today's racing only; track = one track all-time; lifetime = all tracks ever. Defaults to 'today'.",
        },
        track: {
          type: "string",
          description: "Track name when scope='track' (e.g. 'Finger Lakes', 'Saratoga'). Required only for scope=track.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_tier_performance",
    description:
      "Hit rates (win/place/show/ITM) for one tier, or all tiers if none given. Use for " +
      "'how's SNIPER doing', 'show me EDGE performance'.",
    input_schema: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: TIERS as unknown as string[],
          description: "Tier to detail. Omit for all tiers.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_track_record",
    description:
      "Marketing-grade public track record: lifetime cards/races/graded plus overall win/place/" +
      "show/ITM and the strongest tracks by volume. Use for 'what's our public track record'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_card_details",
    description:
      "Detail for a specific card by id or track name (fuzzy), defaulting to the latest active " +
      "card: track, date, status, conviction, race count, and per-race tier + post time. Use for " +
      "'what's on the card today', 'tell me about the Finger Lakes card'.",
    input_schema: {
      type: "object",
      properties: {
        cardId: { type: "integer", description: "Card id. Takes precedence over track." },
        track: { type: "string", description: "Track name, fuzzy-matched. Used if cardId omitted." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_postmortems",
    description:
      "Postmortem narrative for a graded card (defaults to the latest graded card): how the day " +
      "went — wins, ITM, biggest hits and misses by tier. Use for 'what did we learn from " +
      "yesterday', 'how did Saratoga go'.",
    input_schema: {
      type: "object",
      properties: {
        cardId: { type: "integer", description: "Card id. Defaults to the latest graded card." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_bias_today",
    description:
      "Track bias read for today's card (post-position / rail / run-style tendencies derived from " +
      "recent results). Use for 'what's the rail playing like', 'any bias at Finger Lakes'.",
    input_schema: {
      type: "object",
      properties: {
        track: { type: "string", description: "Track to read. Defaults to the active card's track." },
        date: { type: "string", description: "ISO date (YYYY-MM-DD). Defaults to the active card's date." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_otb_finger_lakes_status",
    description:
      "OffTrackBetting's live Finger Lakes view: late scratches, track conditions, and latest " +
      "results — a fallback source independent of our native feed. Use for 'what's OTB saying " +
      "about Finger Lakes', 'any late scratches at Finger Lakes'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ingest_card_for_review",
    description:
      "Pull race data from Equibase and Brisnet for a specific track and date, run handicapping, " +
      "and return a draft card ready for the user to review and lock. Use when the user asks to " +
      "'pull', 'fetch', 'get', 'ingest', or 'load' a card for a specific track and date.",
    input_schema: {
      type: "object",
      properties: {
        track: { type: "string", description: "Track name, e.g. 'Finger Lakes', 'Saratoga'." },
        date: { type: "string", description: "Date in YYYY-MM-DD format. Resolve 'tomorrow'/'Friday' yourself." },
        source: {
          type: "string",
          enum: ["both", "equibase", "brisnet"],
          description: "Which sources to pull. Defaults to both.",
        },
      },
      required: ["track", "date"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_card",
    description:
      "Lock and publish a draft card so it becomes active for grading and the poller. Use when the " +
      "user says 'lock card N', 'publish card N', or 'make card N live'.",
    input_schema: {
      type: "object",
      properties: {
        cardId: { type: "integer", description: "Card id to lock/publish." },
      },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_deep_postmortem",
    description:
      "Run the rigorous deep post-mortem ('answer key') analysis comparing what we knew pre-race " +
      "against what actually happened — where we underweighted a visible signal, where we overrated " +
      "our top pick. Use when the user says 'run a postmortem', 'do the deep dive on today', " +
      "'grade the day', 'where could we have been better'. Defaults to today's graded cards.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["today", "card"],
          description: "'today' runs every graded card from today; 'card' runs one card. Defaults to today.",
        },
        cardId: { type: "integer", description: "Card id. Required when scope is 'card'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_deep_postmortem",
    description:
      "Return the latest saved deep post-mortem for a card (run_deep_postmortem must have been run " +
      "first). Use for 'what did the deep dive say', 'pull up the postmortem for card N'.",
    input_schema: {
      type: "object",
      properties: {
        cardId: { type: "integer", description: "Card id to fetch the saved deep post-mortem for." },
      },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_fusion_replay",
    description:
      "Replay today's graded card(s) through the latest fusion logic without re-ingesting. Shows how many misses the new tier-tuning rules would have caught. Use when user says 'replay', 'rerun fusion', 'how would the new rules have done', 'simulate'.",
    input_schema: {
      type: "object",
      properties: {
        cardId: { type: "number", description: "Card to replay. Omit for today's card." },
      },
    },
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

// ── PR #23 Q&A handlers ─────────────────────────────────────────────────────
// These read aggregate dashboard data directly from the analytics layer +
// storage (the same source the HTTP routes use), so the voice loop answers from
// real numbers without a loopback fetch. All resolve to `{ error }` on failure.

// Flat-bet units for one graded race: +winPayout/2-1 on a win (or +1.5u when the
// payout wasn't captured), -1u on a loss. Mirrors analytics.unitsForRace so the
// P&L spoken to Ken matches the public track-record math.
function unitsForRace(r: RaceWithResult): number {
  if (!r.result) return 0;
  if (r.result.winHit) {
    const wp = r.result.winPayout;
    return wp && wp > 0 ? wp / 2 - 1 : 1.5;
  }
  return -1;
}

// Today's P&L from every card dated today (track-agnostic). Graded = result
// logged; pending = a non-PASS play still awaiting a result.
export function getPnlToday(_input: unknown, _ctx: ToolContext): ToolResult {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cards = storage
      .getCards()
      .filter((c) => c.date === today)
      .map((c) => storage.getCardWithRaces(c.id))
      .filter((c): c is CardWithRaces => !!c);

    const races = cards.flatMap((c) => c.races);
    const graded = races.filter((r) => r.result);
    const pending = races.filter((r) => !r.result && r.tier !== "PASS");
    const units = graded.reduce((a, r) => a + unitsForRace(r), 0);
    const wins = graded.filter((r) => r.result?.winHit).length;
    const roi = graded.length > 0 ? Math.round((units / graded.length) * 1000) / 10 : null;

    return {
      date: today,
      cards: cards.length,
      units: Math.round(units * 10) / 10,
      roiPct: roi,
      wins,
      gradedToday: graded.length,
      pendingToday: pending.length,
    };
  } catch (e) {
    return { error: `P&L lookup failed: ${(e as Error).message}` };
  }
}

export function getLifetimeStats(_input: unknown, _ctx: ToolContext): ToolResult {
  try {
    return buildLifetimeStats() as unknown as Record<string, unknown>;
  } catch (e) {
    return { error: `Lifetime stats failed: ${(e as Error).message}` };
  }
}

export function getAnalyticsSummary(
  input: { scope?: "today" | "track" | "lifetime"; track?: string },
  _ctx: ToolContext,
): ToolResult {
  try {
    const scope = input.scope ?? "today";
    if (scope === "track" && !input.track) {
      return { error: "scope='track' requires a 'track' name (e.g. 'Saratoga'). Pick a track or use scope='today' or scope='lifetime' instead." };
    }
    return buildAnalyticsSummary({ scope, track: input.track }) as unknown as Record<string, unknown>;
  } catch (e) {
    return { error: `Analytics summary failed: ${(e as Error).message}` };
  }
}

export function getTierPerformance(input: { tier?: string }, _ctx: ToolContext): ToolResult {
  try {
    const summary = buildAnalyticsSummary();
    if (input.tier) {
      const row = summary.tierHitRates.find((t) => t.tier === input.tier);
      if (!row) return { tier: input.tier, hitRates: null, note: `No graded ${input.tier} races yet.` };
      return { tier: input.tier, hitRates: row, roi: summary.roi, bestTier: summary.bestTier };
    }
    return { tiers: summary.tierHitRates, roi: summary.roi, bestTier: summary.bestTier };
  } catch (e) {
    return { error: `Tier performance failed: ${(e as Error).message}` };
  }
}

export function getTrackRecord(_input: unknown, _ctx: ToolContext): ToolResult {
  try {
    const { totals, byTrack } = buildLifetimeStats();
    const topTracks = [...byTrack]
      .sort((a, b) => b.graded - a.graded || b.races - a.races || a.track.localeCompare(b.track))
      .slice(0, 5)
      .map((t) => ({ track: t.track, graded: t.graded, win: t.win, itm: t.itm }));
    return {
      cards: totals.cards,
      races: totals.races,
      graded: totals.graded,
      win: totals.win,
      place: totals.place,
      show: totals.show,
      itm: totals.itm,
      topTracks,
    };
  } catch (e) {
    return { error: `Track record failed: ${(e as Error).message}` };
  }
}

// Resolve a card by id, then fuzzy track match, then fall back to the active
// card in context, then the latest card overall. Never throws.
function resolveCard(
  ctx: ToolContext,
  opts: { cardId?: number; track?: string },
): CardWithRaces | undefined {
  if (opts.cardId != null) {
    const c = storage.getCardWithRaces(opts.cardId);
    if (c) return c;
  }
  if (opts.track) {
    const needle = opts.track.toLowerCase();
    const match = storage
      .getCards()
      .filter((c) => c.track.toLowerCase().includes(needle))
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (match) return storage.getCardWithRaces(match.id);
  }
  return ctx.card ?? storage.getLatestCard();
}

export function getCardDetails(input: { cardId?: number; track?: string }, ctx: ToolContext): ToolResult {
  try {
    const card = resolveCard(ctx, input);
    if (!card) return { error: "No card found to detail." };
    return {
      cardId: card.id,
      track: card.track,
      date: card.date,
      status: card.status,
      conviction: card.cardConviction,
      raceCount: card.races.length,
      races: card.races.map((r) => ({
        raceNumber: r.raceNumber,
        tier: r.tier,
        post: r.post,
        conditions: r.conditions,
      })),
    };
  } catch (e) {
    return { error: `Card details failed: ${(e as Error).message}` };
  }
}

// Postmortem narrative for a graded card. Defaults to the most recent card that
// has at least one logged result. Returns structured signal the LLM narrates.
export function getPostmortems(input: { cardId?: number }, ctx: ToolContext): ToolResult {
  try {
    let card: CardWithRaces | undefined;
    if (input.cardId != null) {
      card = storage.getCardWithRaces(input.cardId);
    } else {
      card = storage
        .getCards()
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map((c) => storage.getCardWithRaces(c.id))
        .find((c): c is CardWithRaces => !!c && c.races.some((r) => r.result));
      card = card ?? ctx.card;
    }
    if (!card) return { error: "No graded card to review." };

    const graded = card.races.filter((r) => r.result);
    if (graded.length === 0) {
      return {
        cardId: card.id,
        track: card.track,
        date: card.date,
        gradedRaces: 0,
        note: "No results logged yet for this card.",
      };
    }
    const wins = graded.filter((r) => r.result?.winHit);
    const itm = graded.filter((r) => (r.result?.itmCount ?? 0) > 0);
    const hits = wins.map((r) => ({
      raceNumber: r.raceNumber,
      tier: r.tier,
      pgm: r.winPgm,
      name: r.winName,
      winPayout: r.result?.winPayout ?? null,
    }));
    const misses = graded
      .filter((r) => !r.result?.winHit && (r.result?.itmCount ?? 0) === 0 && r.tier !== "PASS")
      .map((r) => ({ raceNumber: r.raceNumber, tier: r.tier, pgm: r.winPgm, name: r.winName }));

    return {
      cardId: card.id,
      track: card.track,
      date: card.date,
      gradedRaces: graded.length,
      wins: wins.length,
      itm: itm.length,
      winRate: Math.round((wins.length / graded.length) * 100),
      hits,
      misses,
    };
  } catch (e) {
    return { error: `Postmortem failed: ${(e as Error).message}` };
  }
}

// Compact a full DeepPostmortem into a short spoken-friendly payload. Scarlett
// reads the day line + top lesson and points the user to the Postmortem page;
// the heavy per-race breakdown lives on the page, not in a spoken reply.
function summarizeDeepPostmortem(p: DeepPostmortem): ToolResult {
  return {
    cardId: p.cardId,
    track: p.track,
    date: p.date,
    summary: p.summary,
    topLesson: p.lessons[0] ?? null,
    systemicFlags: p.systemicFlags,
    note: "Open the Postmortem page for the full breakdown.",
  };
}

// Run the deep post-mortem. scope 'card' runs one card; 'today' (default) runs
// every graded card from today. Informational — never pushes to ctx.actions, so
// the reply stays on the Scarlett voice.
export async function runDeepPostmortemTool(
  input: { scope?: "today" | "card"; cardId?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const scope = input.scope ?? "today";
    if (scope === "card") {
      const cardId = input.cardId ?? ctx.card?.id;
      if (cardId == null) return { error: "Which card should I run the deep post-mortem on?" };
      const report = await runDeepPostmortem(cardId);
      return summarizeDeepPostmortem(report);
    }
    const reports = await runDeepPostmortemToday();
    if (reports.length === 0) {
      return { scope: "today", count: 0, note: "No graded cards from today to analyze yet." };
    }
    return {
      scope: "today",
      count: reports.length,
      cards: reports.map(summarizeDeepPostmortem),
      note: "Open the Postmortem page for the full breakdown.",
    };
  } catch (e) {
    return { error: `Deep post-mortem failed: ${(e as Error).message}` };
  }
}

// Return the latest saved deep post-mortem for a card. Informational.
export function getDeepPostmortemTool(
  input: { cardId?: number },
  ctx: ToolContext,
): ToolResult {
  try {
    const cardId = input.cardId ?? ctx.card?.id;
    if (cardId == null) return { error: "Which card's deep post-mortem do you want?" };
    const report = getDeepPostmortem(cardId);
    if (!report) {
      return {
        cardId,
        note: "No deep post-mortem saved for that card yet — run one first.",
      };
    }
    return summarizeDeepPostmortem(report);
  } catch (e) {
    return { error: `Failed to fetch deep post-mortem: ${(e as Error).message}` };
  }
}

// Compact a FusionReplay into the spoken-friendly summary Scarlett reads. The
// race-by-race diff lives on the Postmortem page, not in the spoken reply.
function summarizeFusionReplay(r: FusionReplay): ToolResult {
  const s = r.summary;
  const net = s.netImprovement >= 0 ? `+${s.netImprovement}` : `${s.netImprovement}`;
  return {
    cardId: r.cardId,
    track: r.track,
    date: r.date,
    raceCount: r.raceCount,
    graded: r.graded,
    summary: s,
    spoken:
      `Replayed card ${r.cardId}. New rules caught ${s.missesCaught} misses, ` +
      `introduced ${s.missesIntroduced}, net improvement ${net}. ` +
      `Open the Postmortem page for race-by-race breakdown.`,
    note: "Open the Postmortem page for the full race-by-race diff.",
  };
}

// Replay a card (or today's graded cards) through the latest fusion logic.
// Informational — never pushes to ctx.actions, so the reply stays on Scarlett.
export function runFusionReplayTool(
  input: { cardId?: number },
  ctx: ToolContext,
): ToolResult {
  try {
    const cardId = input.cardId ?? ctx.card?.id;
    if (cardId != null) {
      return summarizeFusionReplay(runFusionReplay(cardId));
    }
    const replays = runFusionReplayToday();
    if (replays.length === 0) {
      return { count: 0, note: "No graded cards from today to replay yet." };
    }
    return {
      count: replays.length,
      cards: replays.map(summarizeFusionReplay),
      note: "Open the Postmortem page for the full race-by-race diff.",
    };
  } catch (e) {
    return { error: `Fusion replay failed: ${(e as Error).message}` };
  }
}

export async function getBiasToday(
  input: { track?: string; date?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const track = input.track || ctx.card?.track;
    const date = input.date || ctx.card?.date || new Date().toISOString().slice(0, 10);
    if (!track) return { error: "No track to read bias for." };
    const bias = await getOrFetchBias(track, date);
    if (!bias) return { track, date, bias: null, note: "No bias read available yet." };
    return {
      track: bias.track,
      date: bias.date,
      racesAnalyzed: bias.racesAnalyzed,
      railBias: bias.railBias,
      runStyleBias: bias.runStyleBias,
      narrative: bias.narrative,
      gapNote: bias.gapNote ?? null,
    };
  } catch (e) {
    return { error: `Bias lookup failed: ${(e as Error).message}` };
  }
}

export async function getOtbFingerLakesStatus(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  try {
    const data = await fetchOtbFingerLakes();
    if (!data) {
      return { available: false, note: "OffTrackBetting Finger Lakes data is unavailable right now." };
    }
    return {
      available: true,
      date: data.date,
      scratches: data.scratches,
      conditions: data.conditions,
      results: data.results,
      fetchedAt: data.fetchedAt,
    };
  } catch (e) {
    return { error: `OTB Finger Lakes lookup failed: ${(e as Error).message}` };
  }
}

// ── Action tools (ingest + lock) ─────────────────────────────────────────────
// Both record their name in ctx.actions so the router replies in the Jarvis
// voice (same intent as propose_tier_change, but these take effect immediately).

export async function ingestCardForReview(
  input: { track?: string; date?: string; source?: "both" | "equibase" | "brisnet" },
  ctx: ToolContext,
): Promise<ToolResult> {
  ctx.actions?.push("ingest_card_for_review");
  try {
    if (!input.track || !input.date) {
      return { error: "I need both a track and a date (YYYY-MM-DD) to pull a card." };
    }
    const result = await runOnDemandIngest({
      track: input.track,
      date: input.date,
      source: input.source ?? "both",
    });
    if (result.status === "failed") {
      return { error: result.warnings[0] ?? `Could not pull ${input.track} for ${input.date}.` };
    }
    const races = result.raceCount ?? 0;
    const conv = result.conviction ?? "unrated";
    if (result.warnings.includes("existing card returned, ingest skipped")) {
      return {
        summary:
          `${result.track} for ${result.date} is already on the board as card #${result.cardId} ` +
          `(${races} races, conviction ${conv}). Say 'lock card ${result.cardId}' to publish it.`,
        cardId: result.cardId,
        status: result.status,
      };
    }
    const partialNote =
      result.status === "partial"
        ? ` Brisnet was unavailable, so this is an Equibase-only draft.`
        : "";
    return {
      summary:
        `Pulled ${result.track} for ${result.date}: ${races} races, conviction ${conv}. ` +
        `Card #${result.cardId} is in draft — say 'lock card ${result.cardId}' to publish.${partialNote}`,
      cardId: result.cardId,
      status: result.status,
      raceCount: races,
      conviction: conv,
    };
  } catch (e) {
    return { error: `Ingest failed: ${(e as Error).message}` };
  }
}

export function lockCard(input: { cardId?: number }, ctx: ToolContext): ToolResult {
  ctx.actions?.push("lock_card");
  try {
    if (typeof input.cardId !== "number") {
      return { error: "Which card? Give me a card number to lock." };
    }
    const updated = storage.updateCard(input.cardId, { locked: true });
    if (!updated) return { error: `Card #${input.cardId} not found.` };
    return {
      ok: true,
      cardId: updated.id,
      locked: updated.locked,
      summary: `Card #${updated.id} (${updated.track} ${updated.date}) is locked and live.`,
    };
  } catch (e) {
    return { error: `Lock failed: ${(e as Error).message}` };
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
    case "get_pnl_today":
      return getPnlToday(i, ctx);
    case "get_lifetime_stats":
      return getLifetimeStats(i, ctx);
    case "get_analytics_summary":
      return getAnalyticsSummary(i as { scope?: "today" | "track" | "lifetime"; track?: string }, ctx);
    case "get_tier_performance":
      return getTierPerformance(i as { tier?: string }, ctx);
    case "get_track_record":
      return getTrackRecord(i, ctx);
    case "get_card_details":
      return getCardDetails(i as { cardId?: number; track?: string }, ctx);
    case "get_postmortems":
      return getPostmortems(i as { cardId?: number }, ctx);
    case "get_bias_today":
      return getBiasToday(i as { track?: string; date?: string }, ctx);
    case "get_otb_finger_lakes_status":
      return getOtbFingerLakesStatus(i, ctx);
    case "ingest_card_for_review":
      return ingestCardForReview(
        i as { track?: string; date?: string; source?: "both" | "equibase" | "brisnet" },
        ctx,
      );
    case "lock_card":
      return lockCard(i as { cardId?: number }, ctx);
    case "run_deep_postmortem":
      return runDeepPostmortemTool(
        i as { scope?: "today" | "card"; cardId?: number },
        ctx,
      );
    case "get_deep_postmortem":
      return getDeepPostmortemTool(i as { cardId?: number }, ctx);
    case "run_fusion_replay":
      return runFusionReplayTool(i as { cardId?: number }, ctx);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
