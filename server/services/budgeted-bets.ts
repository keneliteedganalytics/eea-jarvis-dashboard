// Budgeted, tier-weighted bet allocator (PR #40).
//
// Replaces the legacy flat per-race spread (services/wagers.ts) for NEW cards.
// Ken's standing rule: "every day I risk $1k — deploy it wisely for ROI."
//
// The allocator takes the whole card, weights each non-PASS race by its tier,
// and splits a fixed daily budget across them. Each race's budget is then sliced
// into WIN/PLACE/SHOW/EX/TRI/SUPER legs by that tier's leg pattern, rounded to
// track-legal denominations. A chaos flag demotes a race's leg pattern one tier
// (budget unchanged) so volatile races bet more conservatively.
//
// Determinism: same races + same settings → same legs. No randomness, no clock.

import type { Race } from "@shared/schema";

export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

const TIER_ORDER: Tier[] = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"];

export interface LegPattern {
  win: number;
  place: number;
  show: number;
  exacta: number;
  trifecta: number;
  superfecta: number;
}

export type TierWeights = Record<Tier, number>;
export type LegPatterns = Record<Tier, LegPattern>;

export type ChaosDemotionMode = "floor-recon" | "aggressive";

export interface BudgetedBetConfig {
  dailyBudget: number;
  tierWeights: TierWeights;
  legPatterns: LegPatterns;
  chaosDemotionMode: ChaosDemotionMode;
}

export interface BetLeg {
  type: string; // WIN | PLACE | SHOW | EXACTA | TRIFECTA | SUPERFECTA
  structure: string;
  horses: string[];
  cost: number;
}

export interface RaceBets {
  tier: Tier;
  raceAllocation: number;
  pass: boolean;
  legs: BetLeg[];
  demotedFrom?: Tier; // set when a chaos flag dropped the leg pattern
}

// Defaults mirrored from the spec / settings defaults. Used when a settings JSON
// blob is missing a tier or fails to parse.
export const DEFAULT_TIER_WEIGHTS: TierWeights = {
  SNIPER: 30,
  EDGE: 18,
  DUAL: 10,
  RECON: 4,
  PASS: 0,
};

export const DEFAULT_LEG_PATTERNS: LegPatterns = {
  SNIPER: { win: 50, place: 20, show: 0, exacta: 15, trifecta: 15, superfecta: 0 },
  EDGE: { win: 45, place: 25, show: 0, exacta: 30, trifecta: 0, superfecta: 0 },
  DUAL: { win: 35, place: 30, show: 20, exacta: 15, trifecta: 0, superfecta: 0 },
  RECON: { win: 100, place: 0, show: 0, exacta: 0, trifecta: 0, superfecta: 0 },
  PASS: { win: 0, place: 0, show: 0, exacta: 0, trifecta: 0, superfecta: 0 },
};

// Substrings that, when present in any of a race's flags, trigger leg-pattern
// demotion. Case-insensitive contains-match.
const CHAOS_FLAG_SUBSTRINGS = ["FIELD SIZE chaos", "A1_DUAL_DOWNGRADE", "VALUE GATE"];

export function normalizeTier(tier: string): Tier {
  return (TIER_ORDER as string[]).includes(tier) ? (tier as Tier) : "PASS";
}

export function hasChaosFlag(flags: string[]): boolean {
  return flags.some((f) =>
    CHAOS_FLAG_SUBSTRINGS.some((sub) => f.toUpperCase().includes(sub.toUpperCase())),
  );
}

// One step down in conviction. PASS stays PASS.
function demoteTier(tier: Tier, mode: ChaosDemotionMode): Tier {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0 || tier === "PASS") return "PASS";
  // floor-recon: RECON does not demote further (stays RECON); only SNIPER/EDGE/
  // DUAL step down. aggressive: RECON→PASS too.
  if (tier === "RECON") return mode === "aggressive" ? "PASS" : "RECON";
  return TIER_ORDER[idx + 1];
}

// Track-legal rounding. Returns a cost rounded down to the leg's base
// denomination, or 0 if it falls below the minimum (caller rolls into WIN).
function roundLeg(dollars: number, legType: string): number {
  if (dollars <= 0) return 0;
  switch (legType) {
    case "WIN":
    case "PLACE":
    case "SHOW": {
      const r = Math.floor(dollars / 2) * 2; // $2 increments
      return r >= 2 ? r : 0;
    }
    case "EXACTA": {
      const r = Math.floor(dollars); // $1 increments, min $1
      return r >= 1 ? r : 0;
    }
    case "TRIFECTA": {
      const r = Math.floor(dollars / 0.5) * 0.5; // $0.50 increments
      return r >= 0.5 ? Math.round(r * 100) / 100 : 0;
    }
    case "SUPERFECTA": {
      const r = Math.floor(dollars / 0.1) * 0.1; // $0.10 increments
      return r >= 0.1 ? Math.round(r * 100) / 100 : 0;
    }
    default:
      return 0;
  }
}

interface RaceInput {
  winPgm: string | null;
  placePgm: string | null;
  showPgm: string | null;
  fourthPgm: string | null;
}

// Build all legs for a single race given its already-resolved budget + the leg
// pattern to apply (which may be a demoted tier's pattern). Drops legs that round
// below their minimum and rolls their dollars into WIN.
function buildRaceLegs(
  race: RaceInput,
  raceBudget: number,
  pattern: LegPattern,
): BetLeg[] {
  const top = [race.winPgm, race.placePgm, race.showPgm, race.fourthPgm].filter(
    (p): p is string => !!p,
  );
  const [p1, p2, p3, p4] = top;
  if (!p1 || raceBudget <= 0) return [];

  const patternTotal =
    pattern.win + pattern.place + pattern.show + pattern.exacta + pattern.trifecta + pattern.superfecta;
  if (patternTotal <= 0) return [];

  // Raw target dollars per leg from the pattern percentages.
  const target = (pctOfPattern: number) => (raceBudget * pctOfPattern) / 100;

  const placeDollars = target(pattern.place);
  const showDollars = target(pattern.show);
  const exactaDollars = target(pattern.exacta);
  const trifectaDollars = target(pattern.trifecta);
  const superDollars = target(pattern.superfecta);

  // Resolve the non-WIN legs first (rounding down to track-legal denominations;
  // legs with no horses or below their minimum become 0).
  const placeCost = roundLeg(placeDollars, "PLACE");
  const showCost = roundLeg(showDollars, "SHOW");
  const exactaCost = p2 ? roundLeg(exactaDollars, "EXACTA") : 0;
  const trifectaCost = p2 && p3 ? roundLeg(trifectaDollars, "TRIFECTA") : 0;
  const superCost = p2 && p3 && p4 ? roundLeg(superDollars, "SUPERFECTA") : 0;

  // WIN absorbs everything left in the race budget after the other legs are
  // settled. This rolls in both its own pattern share and any dollars that
  // didn't survive rounding (or had no horses). As the remainder bucket it
  // rounds to the NEAREST $2 (not down) so per-race rounding slack doesn't
  // accumulate into a large card-total shortfall.
  const winDollars = raceBudget - (placeCost + showCost + exactaCost + trifectaCost + superCost);
  const winCost = winDollars >= 1 ? Math.round(winDollars / 2) * 2 : 0;

  const legs: BetLeg[] = [];
  if (winCost > 0) legs.push({ type: "WIN", structure: `$${winCost} WIN`, horses: [p1], cost: winCost });
  if (placeCost > 0) legs.push({ type: "PLACE", structure: `$${placeCost} PLACE`, horses: [p1], cost: placeCost });
  if (showCost > 0) legs.push({ type: "SHOW", structure: `$${showCost} SHOW`, horses: [p1], cost: showCost });
  if (exactaCost > 0 && p2) {
    legs.push({
      type: "EXACTA",
      structure: `$${exactaCost} EX box ${p1}-${p2}`,
      horses: [p1, p2],
      cost: exactaCost,
    });
  }
  if (trifectaCost > 0 && p2 && p3) {
    legs.push({
      type: "TRIFECTA",
      structure: `$${trifectaCost.toFixed(2)} TRI box ${p1}-${p2}-${p3}`,
      horses: [p1, p2, p3],
      cost: trifectaCost,
    });
  }
  if (superCost > 0 && p2 && p3 && p4) {
    legs.push({
      type: "SUPERFECTA",
      structure: `$${superCost.toFixed(2)} SUPER box ${p1}-${p2}-${p3}-${p4}`,
      horses: [p1, p2, p3, p4],
      cost: superCost,
    });
  }
  return legs;
}

export type BudgetedRace = Pick<
  Race,
  "id" | "tier" | "flags" | "winPgm" | "placePgm" | "showPgm" | "fourthPgm"
>;

// Build per-race bets for an entire card. Returns a map keyed by race id so the
// caller can attach each race's bets onto its row.
export function buildBudgetedBets(
  raceRows: BudgetedRace[],
  config: BudgetedBetConfig,
): Map<number, RaceBets> {
  const out = new Map<number, RaceBets>();

  const parsed = raceRows.map((r) => {
    let flags: string[] = [];
    try {
      const j = JSON.parse(r.flags || "[]");
      if (Array.isArray(j)) flags = j.map(String);
    } catch {
      flags = [];
    }
    return { row: r, tier: normalizeTier(r.tier), flags };
  });

  const cardTotalWeight = parsed.reduce((a, p) => a + (config.tierWeights[p.tier] ?? 0), 0);

  for (const p of parsed) {
    const tier = p.tier;
    const weight = config.tierWeights[tier] ?? 0;
    if (tier === "PASS" || weight <= 0 || cardTotalWeight <= 0) {
      out.set(p.row.id, { tier, raceAllocation: 0, pass: true, legs: [] });
      continue;
    }
    const raceBudget = (weight / cardTotalWeight) * config.dailyBudget;

    // Chaos demotion only changes which LEG PATTERN applies; budget is unchanged.
    let patternTier: Tier = tier;
    let demotedFrom: Tier | undefined;
    if (hasChaosFlag(p.flags)) {
      const demoted = demoteTier(tier, config.chaosDemotionMode);
      if (demoted !== tier) {
        patternTier = demoted;
        demotedFrom = tier;
      }
    }
    const pattern = config.legPatterns[patternTier] ?? DEFAULT_LEG_PATTERNS[patternTier];

    const legs = buildRaceLegs(p.row, raceBudget, pattern);
    out.set(p.row.id, {
      tier,
      raceAllocation: Math.round(raceBudget * 100) / 100,
      pass: legs.length === 0,
      legs,
      demotedFrom,
    });
  }

  return out;
}

// Parse settings JSON blobs into typed config, falling back to defaults on any
// missing tier or parse failure. Keeps the read path defensive.
export function configFromSettings(s: {
  dailyRiskBudget: number;
  chaosDemotionMode: string;
  tierWeightsJson: string;
  legPatternsJson: string;
}): BudgetedBetConfig {
  const tierWeights: TierWeights = { ...DEFAULT_TIER_WEIGHTS };
  try {
    const parsed = JSON.parse(s.tierWeightsJson) as Partial<TierWeights>;
    for (const t of TIER_ORDER) {
      if (typeof parsed[t] === "number") tierWeights[t] = parsed[t] as number;
    }
  } catch {
    /* keep defaults */
  }

  const legPatterns: LegPatterns = {
    SNIPER: { ...DEFAULT_LEG_PATTERNS.SNIPER },
    EDGE: { ...DEFAULT_LEG_PATTERNS.EDGE },
    DUAL: { ...DEFAULT_LEG_PATTERNS.DUAL },
    RECON: { ...DEFAULT_LEG_PATTERNS.RECON },
    PASS: { ...DEFAULT_LEG_PATTERNS.PASS },
  };
  try {
    const parsed = JSON.parse(s.legPatternsJson) as Partial<Record<Tier, Partial<LegPattern>>>;
    for (const t of TIER_ORDER) {
      const pat = parsed[t];
      if (pat && typeof pat === "object") {
        legPatterns[t] = { ...legPatterns[t], ...pat };
      }
    }
  } catch {
    /* keep defaults */
  }

  const mode: ChaosDemotionMode =
    s.chaosDemotionMode === "aggressive" ? "aggressive" : "floor-recon";

  return {
    dailyBudget: s.dailyRiskBudget > 0 ? s.dailyRiskBudget : 1000,
    tierWeights,
    legPatterns,
    chaosDemotionMode: mode,
  };
}
