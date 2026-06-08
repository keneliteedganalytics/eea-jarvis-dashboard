// Deep post-mortem ("answer key") analyzer (PR #25).
//
// After a card is graded, this compares what we KNEW pre-race (the locked
// predictions snapshot + the flattened picks/tier/flags/weather on each race)
// against what ACTUALLY happened (finishing order + payouts), and identifies the
// visible pre-race signals that favored the actual winner but we underweighted —
// "the answers to the test".
//
// Two passes per race:
//   1. Hindsight pass — locate the actual winner in our pre-race pool, read the
//      tier/rating we gave them, and walk the fusion factors (speed/pace/class,
//      bloodstock fit, post-position/rail bias, weather alignment, ML price) to
//      surface which ones favored them but we leaned away from.
//   2. Overweight pass — for the horse we actually topped, flag the factors that
//      pushed them up but did not play (e.g. leaned on a flag-risked top pick).
//
// All data assembly is deterministic and testable without the DB/LLM. The LLM
// only writes the human-readable visibleSignals[].detail strings + the lessons[]
// bullets, as a brutally-objective senior handicapper grading the day. The LLM
// is injectable so tests run without a live key.

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { resolveAnthropic } from "./anthropic-client";
import type {
  CardWithRaces,
  RaceWithResult,
  Prediction,
  DeepPostmortem,
  DeepRacePostmortem,
  VisibleSignal,
} from "@shared/schema";

// ── LLM narrator (injectable for tests) ──────────────────────────────────────
export interface PostmortemNarrator {
  // Given the deterministic per-race assembly, return polished detail strings for
  // each race's visibleSignals (keyed by raceNumber) plus the card-level lessons.
  narrate(input: NarratorInput): Promise<NarratorOutput>;
}

export interface NarratorInput {
  track: string;
  date: string;
  races: {
    raceNumber: number;
    outcome: string;
    ourTopPick: { runner: string; tier: string; rating: number };
    actualWinner: { runner: string; programNumber: number; odds?: number };
    winnerWasInPool: boolean;
    winnerTier: string | null;
    winnerRating: number | null;
    rawSignals: { signal: string; detail: string; wouldHaveFlipped: boolean }[];
    overweightedFactors: string[];
    paceShape: string;
    biasAlignment: string;
    weatherAlignment: string;
  }[];
  systemicFlags: string[];
}

export interface NarratorOutput {
  // raceNumber → polished detail per signal (same order/length as rawSignals).
  raceSignalDetails: Record<number, string[]>;
  lessons: string[];
}

const ANALYZER_SYSTEM = `You are a senior horse-racing handicapper grading another handicapper's day, line by line, after the results are in. Be brutally objective. If an obvious signal was missed, say so plainly — name the horse, the figure, the angle. No hedging, no flattery, no "great job overall", no "tough beat" sympathy. Speak the way a sharp veteran critiques a colleague's card: direct, specific, numbers-first. When a call was correct for the right reason, say that crisply too — but never pad.`;

// Build the user prompt: a compact, factual dump of the day the model narrates.
function buildNarratorPrompt(input: NarratorInput): string {
  const lines: string[] = [
    `<card>${input.track} — ${input.date}</card>`,
    `Grade every race below. For each race I give you our pre-race top pick + tier,`,
    `the actual winner, where (if at all) the winner sat in our pool, and the raw`,
    `signals we detected in hindsight. Rewrite each raw signal's "detail" as one`,
    `sharp sentence a senior handicapper would say. Then write 3-7 card-level`,
    `lessons across the day — patterns, not race-by-race repeats.`,
    "",
  ];
  for (const r of input.races) {
    lines.push(`<race n="${r.raceNumber}" outcome="${r.outcome}">`);
    lines.push(
      `Our top: #${r.ourTopPick.runner} (${r.ourTopPick.tier}, rating ${r.ourTopPick.rating}).`,
    );
    lines.push(
      `Winner: #${r.actualWinner.programNumber} ${r.actualWinner.runner}` +
        (r.actualWinner.odds != null ? ` at ${r.actualWinner.odds}-1.` : "."),
    );
    lines.push(
      r.winnerWasInPool
        ? `We rated the winner: tier ${r.winnerTier ?? "—"}, rating ${r.winnerRating ?? "—"}.`
        : `We did NOT rate the winner at all.`,
    );
    lines.push(`Pace: ${r.paceShape}. Bias: ${r.biasAlignment}. Weather: ${r.weatherAlignment}.`);
    if (r.rawSignals.length) {
      lines.push(`Raw signals (rewrite each detail, keep order):`);
      r.rawSignals.forEach((s, i) =>
        lines.push(`  [${i}] signal="${s.signal}" wouldHaveFlipped=${s.wouldHaveFlipped} :: ${s.detail}`),
      );
    } else {
      lines.push(`Raw signals: none (we got this one right or there was nothing to see).`);
    }
    if (r.overweightedFactors.length) {
      lines.push(`We overweighted: ${r.overweightedFactors.join("; ")}.`);
    }
    lines.push(`</race>`);
  }
  if (input.systemicFlags.length) {
    lines.push("", `Systemic patterns detected: ${input.systemicFlags.join("; ")}.`);
  }
  lines.push(
    "",
    `Respond with STRICT JSON only, no prose around it:`,
    `{"raceSignalDetails": {"<raceNumber>": ["detail0", "detail1", ...]}, "lessons": ["...", "..."]}`,
    `Each race's detail array MUST match the number of raw signals for that race (or [] if none).`,
  );
  return lines.join("\n");
}

// Default narrator backed by Anthropic Claude Sonnet 4.5. Falls back to the
// deterministic raw details if the key is missing or the call/parse fails, so a
// post-mortem always returns structured output even with no LLM available.
export function anthropicNarrator(deps?: { client?: Anthropic; model?: string }): PostmortemNarrator {
  return {
    async narrate(input: NarratorInput): Promise<NarratorOutput> {
      let client = deps?.client;
      let model = deps?.model;
      if (!client || !model) {
        try {
          const resolved = resolveAnthropic();
          client = client ?? resolved.client;
          model = model ?? resolved.model;
        } catch {
          return fallbackNarration(input);
        }
      }
      try {
        const resp = await client.messages.create({
          model: model!,
          max_tokens: 1500,
          system: ANALYZER_SYSTEM,
          messages: [{ role: "user", content: buildNarratorPrompt(input) }],
        });
        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        const parsed = parseNarratorJson(text);
        if (!parsed) return fallbackNarration(input);
        return parsed;
      } catch {
        return fallbackNarration(input);
      }
    },
  };
}

// Pull the JSON object out of the model's reply (handles ```json fences / stray
// prose) and validate the minimal shape we need.
function parseNarratorJson(text: string): NarratorOutput | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      raceSignalDetails?: Record<string, string[]>;
      lessons?: string[];
    };
    const raceSignalDetails: Record<number, string[]> = {};
    for (const [k, v] of Object.entries(obj.raceSignalDetails ?? {})) {
      if (Array.isArray(v)) raceSignalDetails[Number(k)] = v.map((s) => String(s));
    }
    const lessons = Array.isArray(obj.lessons) ? obj.lessons.map((s) => String(s)) : [];
    return { raceSignalDetails, lessons };
  } catch {
    return null;
  }
}

// Deterministic fallback narration: reuse the raw signal details verbatim and
// synthesize plain-but-honest lessons from the assembled data.
function fallbackNarration(input: NarratorInput): NarratorOutput {
  const raceSignalDetails: Record<number, string[]> = {};
  for (const r of input.races) {
    raceSignalDetails[r.raceNumber] = r.rawSignals.map((s) => s.detail);
  }
  const lessons: string[] = [];
  const misses = input.races.filter((r) => r.outcome === "miss");
  const flips = input.races.filter((r) => r.rawSignals.some((s) => s.wouldHaveFlipped));
  if (flips.length) {
    lessons.push(
      `${flips.length} race(s) had a visible signal that would have flipped our top pick — ` +
        `we left winners on the table in R${flips.map((r) => r.raceNumber).join(", R")}.`,
    );
  }
  if (misses.length) {
    lessons.push(
      `${misses.length} of ${input.races.length} graded races were outright misses — ` +
        `tighten the spots where the winner sat outside our top tier.`,
    );
  }
  for (const f of input.systemicFlags) lessons.push(f);
  if (lessons.length === 0) {
    lessons.push("No structural leaks today — the calls that lost lost on merit, not on a missed signal.");
  }
  return { raceSignalDetails, lessons: lessons.slice(0, 7) };
}

// ── Deterministic data assembly ──────────────────────────────────────────────

type Outcome = DeepRacePostmortem["outcome"];

// finishOrder[0] is the actual winner's program number.
function finishOrderOf(race: RaceWithResult): string[] {
  if (!race.result) return [];
  try {
    const fo = JSON.parse(race.result.finishOrder) as unknown;
    return Array.isArray(fo) ? fo.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// Derive our outcome on the race from the graded result + our flattened picks.
function deriveOutcome(race: RaceWithResult): Outcome {
  const r = race.result;
  if (!r) return "miss";
  if (r.winHit) return "hit";
  if (r.placeHit) return "place";
  if (r.showHit) return "show";
  if ((r.itmCount ?? 0) > 0) return "itm";
  return "miss";
}

// Index pre-race predictions by program number for the race. Empty when the card
// was never run through the LLM pipeline (e.g. a hand-seeded card) — the
// analyzer then falls back to the flattened picks on the race row.
function predictionsByPgm(raceId: number): Map<string, Prediction> {
  const m = new Map<string, Prediction>();
  for (const p of storage.getPredictionsByRace(raceId)) m.set(p.horsePgm, p);
  return m;
}

// Resolve the winner's display name: prefer the prediction row, then our own
// flattened picks if we happened to rank them, else a generic label.
function winnerName(
  winnerPgm: string,
  preds: Map<string, Prediction>,
  race: RaceWithResult,
): string {
  const p = preds.get(winnerPgm);
  if (p) return p.horseName;
  for (const slot of [
    [race.winPgm, race.winName],
    [race.placePgm, race.placeName],
    [race.showPgm, race.showName],
    [race.fourthPgm, race.fourthName],
  ] as const) {
    if (slot[0] === winnerPgm && slot[1]) return slot[1];
  }
  return `#${winnerPgm}`;
}

// Our top pick on the race: the prediction ranked #1 if present, else the
// flattened win pick.
function ourTopPick(
  race: RaceWithResult,
  preds: Map<string, Prediction>,
): { runner: string; tier: string; rating: number; pgm: string | null } {
  const ranked = Array.from(preds.values())
    .filter((p) => !p.scratched && p.rank != null)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (ranked.length) {
    const t = ranked[0];
    return {
      runner: t.horseName,
      tier: t.tierAssigned ?? race.tier,
      rating: t.eeaRating ?? race.winScore ?? 0,
      pgm: t.horsePgm,
    };
  }
  return {
    runner: race.winName ?? `#${race.winPgm ?? "?"}`,
    tier: race.tier,
    rating: race.winScore ?? 0,
    pgm: race.winPgm ?? null,
  };
}

// Where did we rank/tier the actual winner pre-race?
function winnerInPool(
  winnerPgm: string,
  preds: Map<string, Prediction>,
  race: RaceWithResult,
): { inPool: boolean; tier: string | null; rating: number | null } {
  const p = preds.get(winnerPgm);
  if (p) {
    return { inPool: true, tier: p.tierAssigned ?? null, rating: p.eeaRating ?? null };
  }
  // No prediction rows: treat our flattened top-4 as the pool.
  for (const slot of [
    [race.winPgm, race.winScore],
    [race.placePgm, race.placeScore],
    [race.showPgm, race.showScore],
    [race.fourthPgm, race.fourthScore],
  ] as const) {
    if (slot[0] === winnerPgm) {
      return { inPool: true, tier: race.tier, rating: (slot[1] as number) ?? null };
    }
  }
  return { inPool: false, tier: null, rating: null };
}

// Read the bias_context_json a prediction stored at lock time (if any).
function biasNoteFor(preds: Map<string, Prediction>): string | null {
  for (const p of Array.from(preds.values())) {
    if (!p.biasContextJson) continue;
    try {
      const b = JSON.parse(p.biasContextJson) as { note?: string | null };
      if (b?.note) return b.note;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Build the raw (pre-LLM) visible signals favoring the winner. Each is a
// deterministic observation drawn from data present BEFORE the race.
function buildRawSignals(
  race: RaceWithResult,
  winnerPgm: string,
  winnerName: string,
  preds: Map<string, Prediction>,
  ourTop: { rating: number; pgm: string | null },
  pool: { inPool: boolean; tier: string | null; rating: number | null },
): VisibleSignal[] {
  const signals: VisibleSignal[] = [];
  const winnerPred = preds.get(winnerPgm);

  // Signal: the winner outrated our top pick in the locked pool, yet we didn't
  // top them — the rating leader lost to a horse we had higher on the page.
  if (pool.inPool && pool.rating != null && pool.rating >= ourTop.rating && winnerPgm !== ourTop.pgm) {
    signals.push({
      signal: "rating rank",
      detail: `${winnerName} carried rating ${pool.rating} — at or above our top pick's ${ourTop.rating} — but we didn't top them.`,
      wouldHaveFlipped: true,
    });
  }

  // Signal: the winner was in our pool but in a soft tier (RECON/PASS) or unranked.
  if (pool.inPool && (pool.tier === "RECON" || pool.tier === "PASS")) {
    signals.push({
      signal: "tier placement",
      detail: `${winnerName} sat in ${pool.tier} on our card — we buried a live one.`,
      wouldHaveFlipped: true,
    });
  }
  if (!pool.inPool) {
    signals.push({
      signal: "off the page",
      detail: `${winnerName} wasn't in our top four at all — a total blank on the eventual winner.`,
      wouldHaveFlipped: true,
    });
  }

  // Signal: bloodstock surface/wet fit favored the winner.
  if (winnerPred?.bloodstockJson) {
    try {
      const bs = JSON.parse(winnerPred.bloodstockJson) as {
        applied?: boolean;
        composite?: number;
        reasonCodes?: string[];
        ratingDelta?: number;
      };
      if (bs.applied && (bs.composite ?? 0) >= 60) {
        signals.push({
          signal: "bloodstock fit",
          detail: `${winnerName} graded a ${bs.composite} bloodstock composite (${(bs.reasonCodes ?? []).join(", ") || "surface/distance fit"}) — pedigree pointed here.`,
          wouldHaveFlipped: (bs.ratingDelta ?? 0) > 0 && pool.tier !== "SNIPER",
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Signal: a flag fired on our top pick (risk we surfaced but kept the pick).
  const flags = JSON.parse(race.flags || "[]") as string[];
  const topFlag = flags.find((f) => ourTop.pgm != null && new RegExp(`on\\s+#\\s*${ourTop.pgm}\\b`).test(f));
  if (topFlag && !race.result?.winHit) {
    signals.push({
      signal: "self-flagged risk",
      detail: `We flagged "${topFlag}" on our own top pick and still led with it — the risk we named is the risk that beat us.`,
      wouldHaveFlipped: false,
    });
  }

  // Signal: off-track surface that the winner's profile (or our weather note) fit.
  const surf = race.weather?.surfaceImpact;
  if (surf && ["wet", "sloppy", "muddy"].includes(surf) && !race.result?.winHit) {
    signals.push({
      signal: "weather",
      detail: `Track came up ${surf} — a wet-track read we didn't lean into when topping the race.`,
      wouldHaveFlipped: false,
    });
  }

  return signals;
}

// Overweighted factors on our (losing) top pick: what pushed them up that didn't
// play. Deterministic, conservative — only emit when our top pick lost.
function buildOverweighted(
  race: RaceWithResult,
  ourTop: { rating: number; pgm: string | null; tier: string },
): string[] {
  if (race.result?.winHit) return [];
  const out: string[] = [];
  const flags = JSON.parse(race.flags || "[]") as string[];
  if (race.tierDemotedBy) {
    out.push(`tier carried risk: ${race.tierDemotedBy}`);
  }
  if (flags.some((f) => ourTop.pgm != null && new RegExp(`on\\s+#\\s*${ourTop.pgm}\\b`).test(f))) {
    out.push("leaned on a top pick we had already flagged");
  }
  if (race.read && /class/i.test(race.read)) {
    out.push("over-weighted the class/figure top in the read; pace or trip didn't back it");
  }
  if (out.length === 0) {
    out.push(`leaned on a ${ourTop.tier} rating (${ourTop.rating}) the result didn't reward`);
  }
  return out;
}

// Describe pace shape from the stored race shape note (no fractionals in this
// data set, so we report the projected shape and whether the result fit it).
function describePace(race: RaceWithResult): string {
  const shape = race.shape?.trim();
  if (!shape) return "no pace note on file";
  return shape;
}

function describeBias(biasNote: string | null, race: RaceWithResult): string {
  if (biasNote) return biasNote;
  if (race.read && /rail|bias|inside|outside|post/i.test(race.read)) {
    return `read referenced post/rail positioning: "${race.read.slice(0, 120)}"`;
  }
  return "no bias read on file for this race";
}

function describeWeather(race: RaceWithResult): string {
  const w = race.weather;
  if (!w || w.surfaceImpact === "unknown") return "no weather signal captured";
  const cond = w.conditions ? `${w.conditions}, ` : "";
  return `${cond}surface read ${w.surfaceImpact}${w.tempF != null ? `, ${Math.round(w.tempF)}°F` : ""}`;
}

// ── Per-race assembly ─────────────────────────────────────────────────────────
function assembleRace(race: RaceWithResult): {
  pm: DeepRacePostmortem;
  rawSignals: VisibleSignal[];
} {
  const preds = predictionsByPgm(race.id);
  const fo = finishOrderOf(race);
  const winnerPgm = fo[0] ?? "";
  const wName = winnerName(winnerPgm, preds, race);
  const ourTop = ourTopPick(race, preds);
  const pool = winnerInPool(winnerPgm, preds, race);
  const outcome = deriveOutcome(race);

  const rawSignals = buildRawSignals(race, winnerPgm, wName, preds, ourTop, pool);
  const overweightedFactors = buildOverweighted(race, ourTop);
  const biasNote = biasNoteFor(preds);

  const pm: DeepRacePostmortem = {
    raceNumber: race.raceNumber,
    ourTopPick: { runner: ourTop.runner, tier: ourTop.tier, rating: round1(ourTop.rating) },
    actualWinner: {
      runner: wName,
      programNumber: Number(winnerPgm) || 0,
      odds: race.result?.winPayout != null ? round1(race.result.winPayout / 2 - 1) : undefined,
    },
    outcome,
    hindsightAnalysis: {
      winnerWasInPool: pool.inPool,
      winnerTier: pool.tier,
      winnerRating: pool.rating != null ? round1(pool.rating) : null,
      visibleSignals: rawSignals,
      overweightedFactors,
    },
    paceShape: describePace(race),
    biasAlignment: describeBias(biasNote, race),
    weatherAlignment: describeWeather(race),
    scratches: {
      preLocked: scratchedPgms(preds, false),
      postLocked: scratchedPgms(preds, true),
      impactedTopPick: scratchImpactedTopPick(preds, ourTop.pgm),
    },
  };
  return { pm, rawSignals };
}

// Program numbers scratched pre-lock vs. post-lock. We don't have an explicit
// lock timestamp on predictions, so all detected scratches are reported as
// post-locked (detected after lock by the scratch-refresh diff); preLocked stays
// empty unless a prediction was never ranked.
function scratchedPgms(preds: Map<string, Prediction>, postLock: boolean): string[] {
  const out: string[] = [];
  for (const p of Array.from(preds.values())) {
    if (!p.scratched) continue;
    const isPost = !!p.scratchedAt;
    if (postLock === isPost) out.push(p.horsePgm);
  }
  return out;
}

function scratchImpactedTopPick(preds: Map<string, Prediction>, topPgm: string | null): boolean {
  if (topPgm == null) return false;
  const p = preds.get(topPgm);
  return !!p?.scratched;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Card-level aggregation ────────────────────────────────────────────────────
// Detect systemic patterns across races (repeated leaks worth tuning).
function detectSystemicFlags(racePms: DeepRacePostmortem[]): string[] {
  const flags: string[] = [];

  const flips = racePms.filter((r) =>
    r.hindsightAnalysis.visibleSignals.some((s) => s.wouldHaveFlipped),
  );
  if (flips.length >= 2) {
    flags.push(
      `Top-pick discipline: ${flips.length} races had a visible signal that should have flipped our top pick (R${flips
        .map((r) => r.raceNumber)
        .join(", R")}).`,
    );
  }

  const buriedWinners = racePms.filter(
    (r) =>
      r.hindsightAnalysis.winnerWasInPool &&
      (r.hindsightAnalysis.winnerTier === "RECON" || r.hindsightAnalysis.winnerTier === "PASS"),
  );
  if (buriedWinners.length >= 2) {
    flags.push(
      `Tier compression: ${buriedWinners.length} winners came from our RECON/PASS tiers — soft tiers are doing real work we aren't pricing.`,
    );
  }

  const blanks = racePms.filter((r) => !r.hindsightAnalysis.winnerWasInPool);
  if (blanks.length >= 2) {
    flags.push(
      `Coverage gap: ${blanks.length} winners were entirely off our top four — widen the net in chaotic/large fields.`,
    );
  }

  const bloodstock = racePms.filter((r) =>
    r.hindsightAnalysis.visibleSignals.some((s) => s.signal === "bloodstock fit"),
  );
  if (bloodstock.length >= 2) {
    flags.push(
      `Bloodstock weight: ${bloodstock.length} winners flashed a strong pedigree fit we underweighted — consider raising the bloodstock factor.`,
    );
  }

  const flagged = racePms.filter((r) =>
    r.hindsightAnalysis.visibleSignals.some((s) => s.signal === "self-flagged risk"),
  );
  if (flagged.length >= 2) {
    flags.push(
      `Heeding our own flags: ${flagged.length} losing top picks were already flagged for risk — the flag system is right; the tier logic isn't listening.`,
    );
  }

  return flags;
}

// Flat-bet units for one graded race (mirrors voice-tools.unitsForRace / the
// public track-record math): +winPayout/2-1 on a win (or +1.5u when the payout
// wasn't captured), -1u on a loss.
function unitsForRace(race: RaceWithResult): number {
  const r = race.result;
  if (!r) return 0;
  if (r.winHit) {
    const wp = r.winPayout;
    return wp && wp > 0 ? wp / 2 - 1 : 1.5;
  }
  return -1;
}

function buildSummary(
  card: CardWithRaces,
  graded: RaceWithResult[],
  racePms: DeepRacePostmortem[],
): DeepPostmortem["summary"] {
  const wins = graded.filter((r) => r.result?.winHit).length;
  const itm = graded.filter((r) => (r.result?.itmCount ?? 0) > 0).length;
  const units = graded.reduce((a, r) => a + unitsForRace(r), 0);
  const winRate = graded.length ? Math.round((wins / graded.length) * 100) : 0;
  const itmRate = graded.length ? Math.round((itm / graded.length) * 100) : 0;
  const roi = graded.length ? round1((units / graded.length) * 100) : 0;

  // Best call: the highest-tier win (SNIPER > EDGE > DUAL > RECON > PASS).
  const TIER_RANK: Record<string, number> = { SNIPER: 5, EDGE: 4, DUAL: 3, RECON: 2, PASS: 1 };
  const hits = racePms.filter((r) => r.outcome === "hit");
  const bestPm = hits.sort(
    (a, b) => (TIER_RANK[b.ourTopPick.tier] ?? 0) - (TIER_RANK[a.ourTopPick.tier] ?? 0),
  )[0];
  const bestCall = bestPm
    ? {
        raceNumber: bestPm.raceNumber,
        tier: bestPm.ourTopPick.tier,
        runner: bestPm.ourTopPick.runner,
        reason: `Topped ${bestPm.ourTopPick.runner} in ${bestPm.ourTopPick.tier} and it won.`,
      }
    : { raceNumber: 0, tier: "—", runner: "—", reason: "No winning top pick on the graded card." };

  // Worst miss: a miss where a visible signal would have flipped us, preferring
  // higher tiers (a SNIPER/EDGE miss stings more).
  const misses = racePms.filter((r) => r.outcome === "miss");
  const flippable = misses
    .filter((r) => r.hindsightAnalysis.visibleSignals.some((s) => s.wouldHaveFlipped))
    .sort((a, b) => (TIER_RANK[b.ourTopPick.tier] ?? 0) - (TIER_RANK[a.ourTopPick.tier] ?? 0));
  const worstPm = flippable[0] ?? misses[0];
  const worstMiss = worstPm
    ? {
        raceNumber: worstPm.raceNumber,
        ourPick: worstPm.ourTopPick.runner,
        actualWinner: worstPm.actualWinner.runner,
        visibleSignal:
          worstPm.hindsightAnalysis.visibleSignals.find((s) => s.wouldHaveFlipped)?.detail ??
          worstPm.hindsightAnalysis.visibleSignals[0]?.detail ??
          "no clear pre-race signal — beaten on merit.",
      }
    : { raceNumber: 0, ourPick: "—", actualWinner: "—", visibleSignal: "No outright misses on the graded card." };

  return {
    raceCount: card.races.length,
    graded: graded.length,
    winRate,
    itmRate,
    roi,
    bestCall,
    worstMiss,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────
export interface RunOpts {
  narrator?: PostmortemNarrator;
}

// Run the deep post-mortem for one card. Analyzes only graded races. Persists
// the result idempotently and returns it.
export async function runDeepPostmortem(cardId: number, opts: RunOpts = {}): Promise<DeepPostmortem> {
  const card = storage.getCardWithRaces(cardId);
  if (!card) throw new Error(`Card ${cardId} not found`);

  const graded = card.races.filter((r) => r.result);
  const assembled = graded.map((r) => assembleRace(r));
  const racePms = assembled.map((a) => a.pm);
  const systemicFlags = detectSystemicFlags(racePms);

  // LLM narrative pass: polish the per-signal details + write card-level lessons.
  const narrator = opts.narrator ?? anthropicNarrator();
  const narratorInput: NarratorInput = {
    track: card.track,
    date: card.date,
    races: racePms.map((pm) => ({
      raceNumber: pm.raceNumber,
      outcome: pm.outcome,
      ourTopPick: pm.ourTopPick,
      actualWinner: pm.actualWinner,
      winnerWasInPool: pm.hindsightAnalysis.winnerWasInPool,
      winnerTier: pm.hindsightAnalysis.winnerTier,
      winnerRating: pm.hindsightAnalysis.winnerRating,
      rawSignals: pm.hindsightAnalysis.visibleSignals,
      overweightedFactors: pm.hindsightAnalysis.overweightedFactors,
      paceShape: pm.paceShape,
      biasAlignment: pm.biasAlignment,
      weatherAlignment: pm.weatherAlignment,
    })),
    systemicFlags,
  };

  let narration: NarratorOutput;
  try {
    narration = await narrator.narrate(narratorInput);
  } catch {
    narration = fallbackNarration(narratorInput);
  }

  // Splice polished details back onto each signal (only when count matches, so a
  // malformed LLM reply can never desync signal→detail).
  for (const pm of racePms) {
    const details = narration.raceSignalDetails[pm.raceNumber];
    if (details && details.length === pm.hindsightAnalysis.visibleSignals.length) {
      pm.hindsightAnalysis.visibleSignals = pm.hindsightAnalysis.visibleSignals.map((s, i) => ({
        ...s,
        detail: details[i] || s.detail,
      }));
    }
  }

  const lessons = (narration.lessons.length ? narration.lessons : fallbackNarration(narratorInput).lessons)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 7);

  const result: DeepPostmortem = {
    cardId: card.id,
    track: card.track,
    date: card.date,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(card, graded, racePms),
    races: racePms,
    lessons,
    systemicFlags,
  };

  storage.upsertDeepPostmortem(card.id, result);
  return result;
}

// Run the deep post-mortem for every graded card dated today.
export async function runDeepPostmortemToday(opts: RunOpts = {}): Promise<DeepPostmortem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cards = storage
    .getCards()
    .filter((c) => c.date === today)
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c && c.races.some((r) => r.result));

  const out: DeepPostmortem[] = [];
  for (const c of cards) {
    out.push(await runDeepPostmortem(c.id, opts));
  }
  return out;
}

// Read the latest saved deep post-mortem for a card (null if never run).
export function getDeepPostmortem(cardId: number): DeepPostmortem | null {
  return storage.getDeepPostmortem(cardId);
}
