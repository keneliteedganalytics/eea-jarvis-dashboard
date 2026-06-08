// Postmortem-driven engine adjustments — Card 1 (Saratoga 2026-06-07) went 3/11
// win with the EDGE tier 0/4. Three failure modes were isolated and are
// corrected here as a deterministic post-LLM pass over the fused field + the
// LLM's flattened picks/tier:
//
//   Fix 1 — Tighten EDGE-tier class flips. R7/R9/R10 all flipped Quant-Capper's
//           top pick (the fused EEA-Rating leader) onto an Equibase class
//           contender; all three flips lost. A flip now requires a class delta
//           >= CLASS_FLIP_THRESHOLD OR a corroborating signal.
//   Fix 2 — Auto-demote the tier when a flag fires on the win/place pick. The
//           flag system surfaced risk (BOUNCE RISK on #1, etc.) but the tier was
//           computed independently. Each flag on a top-2 pick now drops the tier
//           one notch.
//   Fix 3 — Longshot co-top promotion. Field-high pace/speed longshots were
//           called out in the reads (R9 Olazabal, R10 Mo for the King) but stayed
//           in the place/show slot. An EDGE non-top horse with field-high
//           pace/speed AND ML odds >= 6-1 is now co-topped with the win pick.
//
// All three are pure functions so they can be unit-tested without the DB/LLM.

import type { FusedRace, FusedHorse, Tier } from "./eea-fusion";

// Minimum Equibase class delta (EEAC points) required to flip the win pick off
// Quant-Capper's top-rated horse on an EDGE play. Below this, a corroborating
// signal (field-high pace/speed, trainer/jockey edge) is required instead.
export const CLASS_FLIP_THRESHOLD = 7;

// Longshot promotion needs the morning line to be a true price, not the chalk.
export const LONGSHOT_ML_MIN = 6; // 6-1 or longer

// One-notch tier demotion ladder for Fix 2. SNIPER→EDGE→RECON→PASS; DUAL→RECON.
const DEMOTE_ONE: Record<Tier, Tier> = {
  SNIPER: "EDGE",
  EDGE: "RECON",
  DUAL: "RECON",
  RECON: "PASS",
  PASS: "PASS",
};

export function demoteTier(tier: Tier, notches = 1): Tier {
  let t = tier;
  for (let i = 0; i < notches; i++) t = DEMOTE_ONE[t];
  return t;
}

// The flattened picks the LLM (or fallback ranking) produced for a race.
export interface RacePicks {
  winPgm: string | null;
  winName?: string | null;
  placePgm: string | null;
  placeName?: string | null;
  showPgm?: string | null;
  showName?: string | null;
  fourthPgm?: string | null;
  fourthName?: string | null;
}

// ── Field-high helpers ───────────────────────────────────────────────────────
// Returns the max finite value of a numeric field across the fused field.
function fieldMax(horses: FusedHorse[], pick: (h: FusedHorse) => number | null): number | null {
  const xs = horses.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
}

// A horse carries a corroborating signal if it owns (ties) the field-high pace
// or field-high speed, or shows an explicit trainer/jockey edge flag. Pace uses
// eeapFit (shape-adjusted) when present, else raw eeap.
export function hasCorroboratingSignal(horse: FusedHorse, field: FusedHorse[]): boolean {
  const paceOf = (h: FusedHorse) => h.eeapFit ?? h.eeap;
  const maxPace = fieldMax(field, paceOf);
  const maxSpeed = fieldMax(field, (h) => h.eeas);
  const myPace = paceOf(horse);
  const mySpeed = horse.eeas;
  if (maxPace != null && myPace != null && myPace >= maxPace) return true;
  if (maxSpeed != null && mySpeed != null && mySpeed >= maxSpeed) return true;
  // Engine-emitted edges that argue for the flip.
  return horse.flags.some(
    (f) => /trainer|jockey|j\/?t|lone-speed/i.test(f),
  );
}

// ── Fix 1: tighten EDGE-tier class flips ─────────────────────────────────────
export interface FlipDecision {
  flipped: boolean;
  winPgm: string | null;
  reason: string;
}

// On an EDGE play, if the LLM's win pick differs from the fused EEA-Rating
// leader (Quant-Capper's top pick), only honor that flip when the class edge
// clears CLASS_FLIP_THRESHOLD or a corroborating signal backs it; otherwise
// revert the win pick to the engine leader. Every decision is logged.
export function tightenClassFlip(
  fused: FusedRace,
  tier: Tier,
  winPgm: string | null,
): FlipDecision {
  const ranked = fused.horses.filter((h) => h.eeaRating != null);
  const leader = ranked[0];
  // Only gate EDGE plays; nothing to do without a leader or a win pick.
  if (tier !== "EDGE" || !leader || winPgm == null) {
    return { flipped: false, winPgm, reason: "no-op (not an EDGE flip)" };
  }
  if (winPgm === leader.pgm) {
    return { flipped: false, winPgm, reason: `win pick #${winPgm} matches engine leader — no flip` };
  }

  const flipTo = fused.horses.find((h) => h.pgm === winPgm);
  const classDelta =
    flipTo?.eeac != null && leader.eeac != null ? flipTo.eeac - leader.eeac : null;
  const corroborated = flipTo ? hasCorroboratingSignal(flipTo, fused.horses) : false;
  const clears = classDelta != null && classDelta >= CLASS_FLIP_THRESHOLD;

  if (clears || corroborated) {
    const why = clears
      ? `class delta ${classDelta!.toFixed(1)} >= ${CLASS_FLIP_THRESHOLD}`
      : "corroborating pace/speed/connections signal";
    const decision = {
      flipped: true,
      winPgm,
      reason: `flip #${leader.pgm}→#${winPgm} honored (${why})`,
    };
    console.log(`[flip] R${fused.raceNumber}: ${decision.reason}`);
    return decision;
  }

  const deltaStr = classDelta != null ? classDelta.toFixed(1) : "n/a";
  const decision = {
    flipped: false,
    winPgm: leader.pgm,
    reason: `flip #${leader.pgm}→#${winPgm} REVERTED (class delta ${deltaStr} < ${CLASS_FLIP_THRESHOLD}, no corroboration)`,
  };
  console.log(`[flip] R${fused.raceNumber}: ${decision.reason}`);
  return decision;
}

// ── Fix 2: flag-driven tier demotion ─────────────────────────────────────────
// Parse "<TYPE> on #<pgm>" → pgm; the "<TYPE> noted" form has no target.
export function flagTargetPgm(flag: string): string | null {
  const m = flag.match(/on\s+#\s*([0-9A-Za-z]+)\b/);
  return m ? m[1] : null;
}

export interface DemotionResult {
  tier: Tier;
  tierDemotedBy: string | null;
}

// Drop the tier one notch for each flag that targets the win or place pick.
// Flags on show/fourth or with no target don't demote. Records a human-readable
// note for the dashboard.
export function demoteByFlags(
  flags: string[],
  tier: Tier,
  picks: { winPgm: string | null; placePgm: string | null },
): DemotionResult {
  const hits: string[] = [];
  for (const flag of flags) {
    const target = flagTargetPgm(flag);
    if (target == null) continue;
    if (target === picks.winPgm) hits.push(`${flag} (win pick)`);
    else if (target === picks.placePgm) hits.push(`${flag} (place pick)`);
  }
  if (hits.length === 0) return { tier, tierDemotedBy: null };

  const newTier = demoteTier(tier, hits.length);
  return {
    tier: newTier,
    tierDemotedBy: `${tier}→${newTier}: ${hits.join(", ")}`,
  };
}

// ── Fix 3: longshot co-top promotion ─────────────────────────────────────────
export interface CoTopResult {
  coTopPgms: string[]; // win pick plus any promoted longshots
  promoted: string[]; // just the newly promoted longshot pgms
  note: string | null;
}

// On an EDGE play, promote any non-win-pick horse that has BOTH a field-high
// pace OR speed number AND ML odds >= LONGSHOT_ML_MIN. The longshot is added
// alongside the existing win pick (co-top), never replacing it.
//
// TODO(ml-odds): mlOdds is parsed from the Brisnet morning line; cards whose
// source omits the ML leave it null and are skipped here. Wire the Equibase ML
// fallback when that parser lands so longshot promotion isn't ML-source-bound.
export function longshotCoTop(
  fused: FusedRace,
  tier: Tier,
  winPgm: string | null,
): CoTopResult {
  if (tier !== "EDGE" || winPgm == null) {
    return { coTopPgms: winPgm ? [winPgm] : [], promoted: [], note: null };
  }
  const paceOf = (h: FusedHorse) => h.eeapFit ?? h.eeap;
  const maxPace = fieldMax(fused.horses, paceOf);
  const maxSpeed = fieldMax(fused.horses, (h) => h.eeas);

  const promoted: string[] = [];
  for (const h of fused.horses) {
    if (h.pgm === winPgm) continue;
    const fieldHighPace = maxPace != null && paceOf(h) != null && paceOf(h)! >= maxPace;
    const fieldHighSpeed = maxSpeed != null && h.eeas != null && h.eeas >= maxSpeed;
    const isLongshot = h.mlOdds != null && h.mlOdds >= LONGSHOT_ML_MIN;
    if ((fieldHighPace || fieldHighSpeed) && isLongshot) promoted.push(h.pgm);
  }

  if (promoted.length === 0) {
    return { coTopPgms: [winPgm], promoted: [], note: null };
  }
  return {
    coTopPgms: [winPgm, ...promoted],
    promoted,
    note: `co-top win bet: #${winPgm} + longshot ${promoted.map((p) => `#${p}`).join(", ")}`,
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export interface AdjustmentResult {
  tier: Tier;
  picks: RacePicks;
  tierDemotedBy: string | null;
  coTopPgms: string[];
  coTopNote: string | null;
  flipDecision: FlipDecision;
}

// Run all three fixes in order on a race. Order matters: tighten the flip first
// (it can change winPgm), then demote on flags against the final win/place
// picks, then evaluate the longshot co-top against the final win pick.
export function applyPostmortemAdjustments(
  fused: FusedRace,
  tier: Tier,
  picks: RacePicks,
  flags: string[],
): AdjustmentResult {
  const flipDecision = tightenClassFlip(fused, tier, picks.winPgm);
  let nextPicks: RacePicks = { ...picks, winPgm: flipDecision.winPgm };
  if (flipDecision.flipped === false && flipDecision.winPgm !== picks.winPgm) {
    // Reverted to engine leader — refresh the win name to match.
    const leaderName = fused.horses.find((h) => h.pgm === flipDecision.winPgm)?.name ?? null;
    nextPicks.winName = leaderName;
  }

  const demotion = demoteByFlags(flags, tier, {
    winPgm: nextPicks.winPgm,
    placePgm: nextPicks.placePgm,
  });

  const coTop = longshotCoTop(fused, demotion.tier, nextPicks.winPgm);

  return {
    tier: demotion.tier,
    picks: nextPicks,
    tierDemotedBy: demotion.tierDemotedBy,
    coTopPgms: coTop.coTopPgms,
    coTopNote: coTop.note,
    flipDecision,
  };
}
