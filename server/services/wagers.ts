// Single source of truth for Suggested Wagers.
//
// Both surfaces that show wagers — the in-app Race Detail view and the
// printable picks sheet (/api/cards/:id/print) — must render byte-identical
// numbers for the same race on the same card. They both call buildWagers(race)
// here so they cannot drift.
//
// Given a race row (tier + the top-4 picks) plus the user's bankroll/risk
// settings and the number of races on the card, derive concrete dollar figures.
// All straight-bet dollars round to the nearest $2 (standard increment); exotic
// box costs are fixed by the base unit and combination count.

import type { Race, Settings } from "@shared/schema";

export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

// Tier share of a single race's allocation. Defaults from the v1 spec; the
// SNIPER/EDGE/DUAL/RECON shares are also user-tunable via settings.
const TIER_MULTIPLIER: Record<Tier, number> = {
  SNIPER: 1.0,
  EDGE: 0.6,
  DUAL: 0.4,
  RECON: 0.2,
  PASS: 0,
};

export interface BetLeg {
  // "WIN" | "PLACE" | "SHOW" | "EXACTA" | "TRIFECTA" | "SUPERFECTA"
  type: string;
  // Human label, e.g. "$1 box 2-10" or "1 KEY over 5,1,2"
  structure: string;
  horses: string[];
  cost: number;
}

export interface RaceBets {
  tier: Tier;
  raceAllocation: number; // dollars apportioned to this race for straight bets
  pass: boolean;
  legs: BetLeg[];
}

// The settings the builder actually depends on. Keeping this narrow makes the
// determinism guarantee explicit: same race + same bankroll/cap -> same wagers.
export type WagerSettings = Pick<Settings, "bankroll" | "dailyRiskCapPct">;

// Round to the nearest $2 (min $2 once any allocation exists).
function roundTo2(n: number): number {
  if (n <= 0) return 0;
  const r = Math.round(n / 2) * 2;
  return Math.max(2, r);
}

function normalizeTier(tier: string): Tier {
  return (["SNIPER", "EDGE", "DUAL", "RECON", "PASS"].includes(tier)
    ? tier
    : "PASS") as Tier;
}

// The canonical builder. Pass the race row itself so both surfaces feed
// identical input. racesOnCard is needed to split the daily cap evenly.
export function buildWagers(
  race: Pick<
    Race,
    "tier" | "winPgm" | "placePgm" | "showPgm" | "fourthPgm"
  >,
  settings: WagerSettings,
  racesOnCard: number,
): RaceBets {
  const tier = normalizeTier(race.tier);
  const races = Math.max(1, racesOnCard);
  const dailyCap = settings.bankroll * settings.dailyRiskCapPct;
  const singleRaceCap = dailyCap / races;
  const raceAllocation = roundTo2(singleRaceCap * TIER_MULTIPLIER[tier]);

  const top = [race.winPgm, race.placePgm, race.showPgm, race.fourthPgm].filter(
    (p): p is string => !!p,
  );

  if (tier === "PASS" || raceAllocation <= 0 || top.length === 0) {
    return { tier, raceAllocation: 0, pass: true, legs: [] };
  }

  const [p1, p2, p3, p4] = top;
  const legs: BetLeg[] = [];

  // WIN / PLACE / SHOW on the top pick — split 60/25/15 of the allocation.
  if (p1) {
    const win = roundTo2(raceAllocation * 0.6);
    const place = roundTo2(raceAllocation * 0.25);
    const show = roundTo2(raceAllocation * 0.15);
    legs.push({ type: "WIN", structure: `$${win} WIN`, horses: [p1], cost: win });
    legs.push({ type: "PLACE", structure: `$${place} PLACE`, horses: [p1], cost: place });
    legs.push({ type: "SHOW", structure: `$${show} SHOW`, horses: [p1], cost: show });
  }

  // EXACTA — top 2. SNIPER keys the top pick over #2; others box.
  if (p1 && p2) {
    if (tier === "SNIPER") {
      legs.push({
        type: "EXACTA",
        structure: `$2 EX ${p1} KEY / ${p2}`,
        horses: [p1, p2],
        cost: 2,
      });
    } else {
      legs.push({
        type: "EXACTA",
        structure: `$1 EX box ${p1}-${p2}`,
        horses: [p1, p2],
        cost: 2, // $1 box of 2 = 2 combos = $2
      });
    }
  }

  // TRIFECTA — top 3. SNIPER keys top over 2,3; others $0.50 box.
  if (p1 && p2 && p3) {
    if (tier === "SNIPER") {
      // 1 KEY over (2,3) for 2nd, and the remaining two for 3rd: 2 combos @ $0.50 = $1.
      legs.push({
        type: "TRIFECTA",
        structure: `$0.50 TRI ${p1} KEY / ${p2},${p3}`,
        horses: [p1, p2, p3],
        cost: 1,
      });
    } else {
      legs.push({
        type: "TRIFECTA",
        structure: `$0.50 TRI box ${p1}-${p2}-${p3}`,
        horses: [p1, p2, p3],
        cost: 3, // $0.50 box of 3 = 6 combos = $3
      });
    }
  }

  // SUPERFECTA — top 4. SNIPER keys top over 2,3,4; others $0.10 box.
  if (p1 && p2 && p3 && p4) {
    if (tier === "SNIPER") {
      // 1 KEY / 2,3,4 / 2,3,4 / 2,3,4 = 6 combos @ $0.10 = $0.60.
      legs.push({
        type: "SUPERFECTA",
        structure: `$0.10 SUPER ${p1} KEY / ${p2},${p3},${p4}`,
        horses: [p1, p2, p3, p4],
        cost: 0.6,
      });
    } else {
      legs.push({
        type: "SUPERFECTA",
        structure: `$0.10 SUPER box ${p1}-${p2}-${p3}-${p4}`,
        horses: [p1, p2, p3, p4],
        cost: 2.4, // $0.10 box of 4 = 24 combos = $2.40
      });
    }
  }

  return { tier, raceAllocation, pass: false, legs };
}
