// v4 rating smoke test (v4-lock-2026-06-12).
//
// Grades two self-contained fixtures and asserts the locked engine reproduces
// the two reference reads from the 23-race calibration sample:
//   - Churchill 6/11 R3  → SNIPER, anchor #2 Argan
//   - Belmont   6/11 R5  → EDGE,   anchor #11 Athena's Fury
//
// Fixtures carry full per-horse feature values (not the winner-rank summaries in
// calibration_locked.json) so gradeCard() can recompute composites end-to-end.
// Rank profiles match the calibration file: Argan is the field-best across the
// board (→ SNIPER); Athena's Fury is prime-best but pc3 rank 4 (→ EDGE, not
// SNIPER, since SNIPER requires pc3_rank ≤ 2).
//
// Run: npx tsx scripts/v4_smoke_test.ts   (exit 0 = pass, 1 = fail)

import { gradeCard, type V4Grade } from "../server/services/v4_rating";

// Churchill flat schema: races[].horses[] with brisnet_prime_power, equibase_*.
// 7-horse field; #2 Argan dominates every feature → composite 100 → SNIPER.
const churchill = {
  track: "Churchill Downs",
  date: "2026-06-11",
  races: [
    {
      race: 3,
      horses: [
        { pgm: "1", name: "Bourbon Bay", brisnet_prime_power: 142, equibase_class_rating: 108, equibase_speed_last3: 88, equibase_pace_avg_last3: 90, jt_itm_pct: 14, ml_odds: "5/1" },
        { pgm: "2", name: "Argan", brisnet_prime_power: 165, equibase_class_rating: 124, equibase_speed_last3: 101, equibase_pace_avg_last3: 99, jt_itm_pct: 28, ml_odds: "2/1" },
        { pgm: "3", name: "Cedar Run", brisnet_prime_power: 150, equibase_class_rating: 115, equibase_speed_last3: 95, equibase_pace_avg_last3: 98, jt_itm_pct: 20, ml_odds: "3/1" },
        { pgm: "4", name: "Drift Wood", brisnet_prime_power: 138, equibase_class_rating: 104, equibase_speed_last3: 85, equibase_pace_avg_last3: 84, jt_itm_pct: 10, ml_odds: "8/1" },
        { pgm: "5", name: "Even Keel", brisnet_prime_power: 130, equibase_class_rating: 100, equibase_speed_last3: 80, equibase_pace_avg_last3: 80, jt_itm_pct: 9, ml_odds: "12/1" },
        { pgm: "6", name: "Far Cry", brisnet_prime_power: 125, equibase_class_rating: 96, equibase_speed_last3: 78, equibase_pace_avg_last3: 76, jt_itm_pct: 7, ml_odds: "15/1" },
        { pgm: "7", name: "Gale Force", brisnet_prime_power: 120, equibase_class_rating: 92, equibase_speed_last3: 74, equibase_pace_avg_last3: 72, jt_itm_pct: 6, ml_odds: "20/1" },
      ],
    },
  ],
};

// Belmont nested-brisnet schema: races[].runners[] with brisnet.prime_power +
// equibase.{class_rating,spd_avg3,pace_avg3,jt_pct} + mlOdds. 13-horse field;
// #11 Athena's Fury is prime-best (rank 1) but only pc3 rank 4 → EDGE, not
// SNIPER (which needs pc3 rank ≤ 2). Composite stays ≥ 80.
function belRunner(
  pgm: string,
  name: string,
  prime: number,
  cls: number,
  spd: number,
  pace: number,
  jt: number,
  ml: string,
) {
  return {
    pgm,
    name,
    brisnet: { prime_power: prime },
    equibase: { class_rating: cls, spd_avg3: spd, pace_avg3: pace, jt_pct: `${jt}%` },
    mlOdds: ml,
  };
}

const belmont = {
  track: "Belmont Park",
  date: "2026-06-11",
  races: [
    {
      raceNumber: 5,
      runners: [
        // #11 Athena's Fury: prime #1, class #1, spd #1, jt #1, ml #1, but only
        // pc3 #4 (three horses beat her on pace). High composite anchor → EDGE,
        // blocked from SNIPER by the pc3_rank ≤ 2 gate.
        belRunner("11", "Athena's Fury", 185, 128, 104, 92, 32, "2/1"),
        // Three pace-forward types outrank Athena ONLY on pace_avg3.
        belRunner("1", "Quiet Power", 170, 120, 99, 102, 18, "5/2"),
        belRunner("2", "Bold Venture", 168, 118, 98, 101, 16, "3/1"),
        belRunner("3", "Storm Watch", 166, 116, 97, 100, 15, "4/1"),
        // Remainder trail Athena across the board.
        belRunner("4", "Iron Will", 160, 112, 94, 88, 14, "6/1"),
        belRunner("5", "Night Shift", 155, 108, 91, 86, 12, "8/1"),
        belRunner("6", "Open Road", 150, 104, 89, 84, 11, "10/1"),
        belRunner("7", "Pace Setter", 145, 100, 86, 82, 9, "12/1"),
        belRunner("8", "Quick Step", 140, 96, 83, 80, 8, "15/1"),
        belRunner("9", "River Bend", 135, 92, 80, 78, 7, "20/1"),
        belRunner("10", "Slow Burn", 130, 88, 77, 76, 6, "25/1"),
        belRunner("12", "Twin Spires", 125, 84, 74, 74, 5, "30/1"),
        belRunner("13", "Up Tempo", 120, 80, 71, 70, 4, "40/1"),
      ],
    },
  ],
};

function find(grades: V4Grade[], race: number): V4Grade {
  const g = grades.find((x) => Number(x.race) === race);
  if (!g) throw new Error(`No grade returned for race ${race}`);
  return g;
}

let failed = false;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: got ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) failed = true;
}

console.log("v4 smoke test — v4-lock-2026-06-12\n");

const ch = find(gradeCard(churchill), 3);
console.log(`Churchill R3 → tier=${ch.tier} anchor=#${ch.anchorPp} ${ch.anchorName} composite=${ch.composite}`);
check("Churchill R3 tier is SNIPER", ch.tier, "SNIPER");
check("Churchill R3 anchor pp is 2", ch.anchorPp, "2");
check("Churchill R3 anchor name is Argan", ch.anchorName, "Argan");

console.log();

const bel = find(gradeCard(belmont), 5);
console.log(`Belmont R5 → tier=${bel.tier} anchor=#${bel.anchorPp} ${bel.anchorName} composite=${bel.composite}`);
check("Belmont R5 tier is EDGE", bel.tier, "EDGE");
check("Belmont R5 anchor pp is 11", bel.anchorPp, "11");
check("Belmont R5 anchor name is Athena's Fury", bel.anchorName, "Athena's Fury");

console.log();
if (failed) {
  console.error("v4 smoke test FAILED");
  process.exit(1);
}
console.log("v4 smoke test PASSED");
process.exit(0);
