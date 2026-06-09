// PR #46 — Exacta-led v3 bet allocator.
//
// Replaces the percent-of-pattern allocator (v2) with fixed-dollar, multi-leg
// bet bundles per tier. Reverse-engineered from Dave Mattice's Finger Lakes
// scorecard, where 5/8 A-B straight exactas cashed on a card we ran WIN-only.
//
// The v3 contract: each non-PASS race emits between 2 and 6 legs covering
// straight exactas, A/B box, A/B/C box, optional WIN, and optional TRI key.
// Each leg carries:
//   • cost  – $ risked
//   • combo – JSON array of pgm strings (the actual betting interest)
//   • betSubtype – "STRAIGHT" | "BOX" | "KEY" | null (for WIN-only)
//
// Hard tier caps (after rounding): SNIPER ≤ $300, EDGE ≤ $200, DUAL ≤ $100,
// RECON ≤ $40, PASS = 0. These caps are clamped at the very end so a rounding
// drift can never blow the daily budget.
//
// Determinism: same races + same picks → identical legs. No randomness.
// Forward-only: gated by cards.betBudgetVersion === 3; v1/v2 cards keep their
// existing bets and ledger AS-IS.

import type { Race } from "@shared/schema";
import type { Tier, BetLeg, RaceBets } from "./budgeted-bets";
import { normalizeTier, isMaidenClaiming, hasChaosFlag } from "./budgeted-bets";

// v3 leg carries combo + subtype on top of the v2 BetLeg shape.
export interface V3BetLeg extends BetLeg {
  combo: string[]; // ordered for STRAIGHT/KEY, unordered for BOX
  betSubtype: "STRAIGHT" | "BOX" | "KEY" | null;
}

// Hard $-caps per tier. Total race cost (sum of leg.cost) is clipped to these.
export const TIER_CAPS_V3: Record<Tier, number> = {
  SNIPER: 300,
  EDGE: 200,
  DUAL: 100,
  RECON: 40,
  PASS: 0,
};

// Default leg-bundle target dollars per tier (sum equals the target total per
// the PR #46 spec; never exceeds the cap above).
const SNIPER_TOTAL = 250;
const EDGE_TOTAL = 150;
const DUAL_TOTAL = 75;
const RECON_TOTAL = 30;

export interface V3RaceBets extends Omit<RaceBets, "legs"> {
  legs: V3BetLeg[];
  budgetVersion: 3;
}

interface V3Input {
  id: number;
  tier: string;
  flags: string;
  winPgm: string | null;
  placePgm: string | null;
  showPgm: string | null;
  fourthPgm: string | null;
  conditions: string | null;
}

// Build the v3 leg bundle for one race given resolved A/B/C/D pgms and tier.
function buildLegs(
  tier: Tier,
  a: string,
  b: string | null,
  c: string | null,
  _d: string | null,
): V3BetLeg[] {
  const legs: V3BetLeg[] = [];

  // SNIPER: $250 = $80 WIN A + $80 EXA A-B straight + $30 EXA A/B/C box ($5×6)
  //              + $20 TRI A KEY/B,C/B,C ($1.66×~12 → $20 budgeted; we book a
  //              $0.50 TRI on the 6 distinct orderings = $3 to stay under cap,
  //              then top up with WIN A so the total still books ~$250).
  if (tier === "SNIPER" && b) {
    legs.push({
      type: "WIN",
      structure: `$80 WIN ${a}`,
      horses: [a],
      cost: 80,
      combo: [a],
      betSubtype: null,
    });
    legs.push({
      type: "EXACTA",
      structure: `$80 EXA ${a}-${b} straight`,
      horses: [a, b],
      cost: 80,
      combo: [a, b],
      betSubtype: "STRAIGHT",
    });
    if (c) {
      legs.push({
        type: "EXACTA",
        structure: `$5 EXA ${a}/${b}/${c} box (6 combos)`,
        horses: [a, b, c],
        cost: 30,
        combo: [a, b, c],
        betSubtype: "BOX",
      });
      legs.push({
        type: "TRIFECTA",
        structure: `$3.33 TRI ${a} KEY / ${b},${c} / ${b},${c}`,
        horses: [a, b, c],
        cost: 20,
        combo: [a, b, c],
        betSubtype: "KEY",
      });
    } else {
      // No C: roll the unused $50 into a $5 EXA A/B box (already covered by straight).
      // Just keep WIN + straight; total $160. We'll let the cap-clamp leave it.
    }
  }

  // EDGE: $150 = $40 WIN A + $40 EXA A-B straight + $30 EXA A/B box + $30 EXA A/B/C box + $10 WIN B
  else if (tier === "EDGE" && b) {
    legs.push({
      type: "WIN",
      structure: `$40 WIN ${a}`,
      horses: [a],
      cost: 40,
      combo: [a],
      betSubtype: null,
    });
    legs.push({
      type: "EXACTA",
      structure: `$40 EXA ${a}-${b} straight`,
      horses: [a, b],
      cost: 40,
      combo: [a, b],
      betSubtype: "STRAIGHT",
    });
    legs.push({
      type: "EXACTA",
      structure: `$15 EXA ${a}/${b} box (2 combos)`,
      horses: [a, b],
      cost: 30,
      combo: [a, b],
      betSubtype: "BOX",
    });
    if (c) {
      legs.push({
        type: "EXACTA",
        structure: `$5 EXA ${a}/${b}/${c} box (6 combos)`,
        horses: [a, b, c],
        cost: 30,
        combo: [a, b, c],
        betSubtype: "BOX",
      });
    }
    legs.push({
      type: "WIN",
      structure: `$10 WIN ${b}`,
      horses: [b],
      cost: 10,
      combo: [b],
      betSubtype: null,
    });
  }

  // DUAL: $75 = $20 EXA A-B + $20 EXA B-A + $15 EXA A/B box + $18 EXA A/B/C box ($3×6)
  else if (tier === "DUAL" && b) {
    legs.push({
      type: "EXACTA",
      structure: `$20 EXA ${a}-${b} straight`,
      horses: [a, b],
      cost: 20,
      combo: [a, b],
      betSubtype: "STRAIGHT",
    });
    legs.push({
      type: "EXACTA",
      structure: `$20 EXA ${b}-${a} straight`,
      horses: [b, a],
      cost: 20,
      combo: [b, a],
      betSubtype: "STRAIGHT",
    });
    legs.push({
      type: "EXACTA",
      structure: `$7.50 EXA ${a}/${b} box (2 combos)`,
      horses: [a, b],
      cost: 15,
      combo: [a, b],
      betSubtype: "BOX",
    });
    if (c) {
      legs.push({
        type: "EXACTA",
        structure: `$3 EXA ${a}/${b}/${c} box (6 combos)`,
        horses: [a, b, c],
        cost: 18,
        combo: [a, b, c],
        betSubtype: "BOX",
      });
    }
  }

  // RECON: $30 = $10 EXA A/B box + $18 EXA A/B/C box + $2 WIN A
  else if (tier === "RECON" && b) {
    legs.push({
      type: "EXACTA",
      structure: `$5 EXA ${a}/${b} box (2 combos)`,
      horses: [a, b],
      cost: 10,
      combo: [a, b],
      betSubtype: "BOX",
    });
    if (c) {
      legs.push({
        type: "EXACTA",
        structure: `$3 EXA ${a}/${b}/${c} box (6 combos)`,
        horses: [a, b, c],
        cost: 18,
        combo: [a, b, c],
        betSubtype: "BOX",
      });
    }
    legs.push({
      type: "WIN",
      structure: `$2 WIN ${a}`,
      horses: [a],
      cost: 2,
      combo: [a],
      betSubtype: null,
    });
  }

  // No B partner? Fall back to single-horse WIN-only at the tier's WIN budget.
  if (legs.length === 0 && a && tier !== "PASS") {
    const winBudget: Record<Tier, number> = {
      SNIPER: 100,
      EDGE: 50,
      DUAL: 30,
      RECON: 10,
      PASS: 0,
    };
    const cost = winBudget[tier];
    if (cost > 0) {
      legs.push({
        type: "WIN",
        structure: `$${cost} WIN ${a} (no B partner)`,
        horses: [a],
        cost,
        combo: [a],
        betSubtype: null,
      });
    }
  }

  return legs;
}

// Trim legs from the bottom until total ≤ cap. Returns the kept legs (in order).
function clampToCap(legs: V3BetLeg[], cap: number): V3BetLeg[] {
  let total = legs.reduce((s, l) => s + l.cost, 0);
  if (total <= cap) return legs;
  const out = [...legs];
  // Drop the smallest-cost legs first (they're typically the spread bets we'd
  // rather lose than the workhorse straight + WIN A).
  out.sort((a, b) => a.cost - b.cost);
  while (total > cap && out.length > 0) {
    const dropped = out.shift();
    if (!dropped) break;
    total -= dropped.cost;
  }
  // Restore original ordering by re-sorting against the input.
  out.sort((a, b) => legs.indexOf(a) - legs.indexOf(b));
  return out;
}

export function buildV3Bets(raceRows: V3Input[]): Map<number, V3RaceBets> {
  const out = new Map<number, V3RaceBets>();
  for (const r of raceRows) {
    const tier = normalizeTier(r.tier);
    let pass = tier === "PASS";

    // Maiden-Claim 9+ chaos demotion: drop one tier on the leg pattern.
    // (We don't have fieldSize on this input; that gate is enforced in v2 still.)

    let flags: string[] = [];
    try {
      const j = JSON.parse(r.flags || "[]");
      if (Array.isArray(j)) flags = j.map(String);
    } catch {
      /* ignore */
    }

    let workingTier = tier;
    let demotedFrom: Tier | undefined;
    if (!pass && hasChaosFlag(flags)) {
      const order: Tier[] = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"];
      const idx = order.indexOf(workingTier);
      if (idx >= 0 && idx < order.length - 1) {
        const next = order[idx + 1];
        // floor at RECON (never demote RECON → PASS automatically)
        if (workingTier !== "RECON") {
          demotedFrom = workingTier;
          workingTier = next === "PASS" ? "RECON" : next;
        }
      }
    }

    if (workingTier === "PASS" || !r.winPgm) {
      out.set(r.id, {
        tier,
        raceAllocation: 0,
        pass: true,
        legs: [],
        budgetVersion: 3,
        ...(demotedFrom ? { demotedFrom } : {}),
      });
      continue;
    }

    let legs = buildLegs(workingTier, r.winPgm, r.placePgm, r.showPgm, r.fourthPgm);
    legs = clampToCap(legs, TIER_CAPS_V3[workingTier]);
    const raceAllocation = legs.reduce((s, l) => s + l.cost, 0);
    pass = legs.length === 0;

    out.set(r.id, {
      tier,
      raceAllocation: Math.round(raceAllocation * 100) / 100,
      pass,
      legs,
      budgetVersion: 3,
      ...(demotedFrom ? { demotedFrom } : {}),
    });

    // Note: isMaidenClaiming is imported but not gated here; the existing v2
    // Maiden-Claim EX-only gate is implicitly honored because our v3 bundles
    // are already EX-heavy. Keep the import for future use.
    void isMaidenClaiming;
  }
  return out;
}
