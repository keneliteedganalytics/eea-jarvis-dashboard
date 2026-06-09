// Postmortem v2 — deep-feature miss attribution (PR #28b, spec §5).
//
// Given a fused deep card (fusion-v3.ts) and the actual finish order, this
// answers, for each missed pick: WHICH computed feature would have flagged the
// real winner, and WHICH A-rule should have caught it. This is the "answer key"
// expressed against the 12 deep features rather than the legacy fusion factors.
//
// Pure: no DB, no LLM. The replay endpoint (routes) and the lock-in tests both
// consume this. The narrative block format mirrors the spec example so the
// printed/spoken postmortem reads the same.

import type { FusionV3Race, RunnerScore, Tier } from "./fusion-v3";
import { honestyCheck, type RunnerFeatures } from "./features";

// One finish: program number → final position (1 = won).
export type FinishOrder = Record<string, number>;

export interface FeatureFlag {
  feature: keyof RunnerFeatures;
  score: number;
  note: string;
}

export interface RaceMissAttribution {
  raceNumber: number;
  missed: boolean; // true if our top pick did not win
  ourTopPgm: string | null;
  ourTopTier: Tier | null;
  ourTopFinish: number | null;
  winnerPgm: string | null;
  winnerTier: Tier | null;
  // features on which the winner out-rated our top pick (the "answers")
  winnerFlags: FeatureFlag[];
  // why our top pick should have been demoted
  demotionReasons: string[];
  honestyFlagged: boolean;
  // the A-rule(s) that should have caught it
  ruleThatShouldHaveCaught: string[];
  narrative: string;
}

export interface ReplayResult {
  races: RaceMissAttribution[];
  totalRaces: number;
  missesCaught: number; // races where v3 now tops the actual winner
  caughtRaceNumbers: number[];
}

// Pretty labels for the six honesty dimensions + the rest.
const FEATURE_LABEL: Record<keyof RunnerFeatures, string> = {
  pace_fit_score: "pace_fit",
  class_earned_score: "class_earned",
  trip_compromised_score: "trip_compromised",
  bias_match_score: "bias_match",
  jt_hot_score: "jt_hot",
  trainer_angle_score: "trainer_angle",
  work_sharp_score: "work_sharp",
  form_curve_score: "form_curve",
  dist_surf_form_score: "dist_surf_form",
  conditions_pedigree_score: "conditions_pedigree",
  layoff_score: "layoff",
  honesty_check: "honesty_check",
};

const NUMERIC_FEATURES: (keyof RunnerFeatures)[] = [
  "pace_fit_score", "class_earned_score", "dist_surf_form_score", "form_curve_score",
  "bias_match_score", "jt_hot_score", "trainer_angle_score", "conditions_pedigree_score",
  "work_sharp_score", "trip_compromised_score", "layoff_score",
];

function scoreOf(s: RunnerScore | undefined): RunnerFeatures | null {
  return s?.features ?? null;
}

// The features on which the winner clearly out-rates our top pick (≥10 pts, or
// a strong absolute ≥75 the top pick lacked). Sorted by margin desc.
function winnerAdvantages(
  winner: RunnerFeatures,
  ours: RunnerFeatures | null,
): FeatureFlag[] {
  const out: FeatureFlag[] = [];
  for (const f of NUMERIC_FEATURES) {
    const w = winner[f];
    if (typeof w !== "number") continue;
    const o = ours ? ours[f] : null;
    const margin = typeof o === "number" ? w - o : w - 50;
    if (w >= 75 && (typeof o !== "number" || margin >= 10)) {
      out.push({ feature: f, score: w, note: featureNote(f, w) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 3);
}

function featureNote(f: keyof RunnerFeatures, score: number): string {
  switch (f) {
    case "pace_fit_score": return `lone/edge pace fit (${score})`;
    case "bias_match_score": return `style+post bias match (${score})`;
    case "dist_surf_form_score": return `proven dist/surf form (${score})`;
    case "class_earned_score": return `earned class (${score})`;
    case "jt_hot_score": return `hot J/T combo (${score})`;
    case "trainer_angle_score": return `live trainer angle (${score})`;
    case "form_curve_score": return `improving form curve (${score})`;
    default: return `${FEATURE_LABEL[f]} (${score})`;
  }
}

// Attribute one race. winnerScore/ourScore come from the SAME fusion pass —
// "missed" means our v3 top pick is not the actual winner.
export function attributeRace(
  fused: FusionV3Race,
  finish: FinishOrder,
): RaceMissAttribution {
  const tierByPgm = new Map(fused.tiers.map((t) => [t.pgm, t.tier]));
  // our top pick = highest-conviction tier, breaking ties by composite rank.
  const ordered = [...fused.runners].sort((a, b) => {
    const ta = tierRank(tierByPgm.get(a.pgm) ?? "PASS");
    const tb = tierRank(tierByPgm.get(b.pgm) ?? "PASS");
    if (ta !== tb) return ta - tb;
    return a.rank - b.rank;
  });
  const ourTop = ordered[0] ?? null;

  const winnerPgm = Object.keys(finish).find((p) => finish[p] === 1) ?? null;
  const winner = winnerPgm ? fused.runners.find((r) => r.pgm === winnerPgm) ?? null : null;

  const ourTopFinish = ourTop ? finish[ourTop.pgm] ?? null : null;
  const missed = winnerPgm != null && ourTop != null && ourTop.pgm !== winnerPgm;

  const winnerFeatures = scoreOf(winner ?? undefined);
  const ourFeatures = scoreOf(ourTop ?? undefined);

  const winnerFlags = winnerFeatures ? winnerAdvantages(winnerFeatures, ourFeatures) : [];

  const demotionReasons: string[] = [];
  let honestyFlagged = false;
  const rules: string[] = [];

  if (missed && ourFeatures && winnerFeatures) {
    const ce = ourFeatures.class_earned_score;
    if (ce != null && ce < 50) {
      demotionReasons.push(`class_earned ${ce} (low)`);
      rules.push("A1 earned-class gate");
    }
    const hc = honestyCheck(ourFeatures, winnerFeatures);
    if (hc.flagged) {
      honestyFlagged = true;
      demotionReasons.push(`honesty_check = true (winner beat on ${hc.reasons.join(" + ")})`);
      rules.push("A4 honesty_check");
    }
    if (winnerFlags.some((f) => f.feature === "bias_match_score" && f.score >= 80)) {
      rules.push("Track Bias promotion");
    }
  }

  return {
    raceNumber: fused.raceNumber,
    missed,
    ourTopPgm: ourTop?.pgm ?? null,
    ourTopTier: ourTop ? tierByPgm.get(ourTop.pgm) ?? null : null,
    ourTopFinish,
    winnerPgm,
    winnerTier: winnerPgm ? tierByPgm.get(winnerPgm) ?? null : null,
    winnerFlags,
    demotionReasons,
    honestyFlagged,
    ruleThatShouldHaveCaught: Array.from(new Set(rules)),
    narrative: renderNarrative(fused, finish, {
      ourTop,
      ourTopFinish,
      winner,
      winnerFlags,
      demotionReasons,
      missed,
      tierByPgm,
    }),
  };
}

function tierRank(t: Tier): number {
  return ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"].indexOf(t);
}

function renderNarrative(
  fused: FusionV3Race,
  _finish: FinishOrder,
  ctx: {
    ourTop: RunnerScore | null;
    ourTopFinish: number | null;
    winner: RunnerScore | null;
    winnerFlags: FeatureFlag[];
    demotionReasons: string[];
    missed: boolean;
    tierByPgm: Map<string, Tier>;
  },
): string {
  const { ourTop, ourTopFinish, winner, winnerFlags, demotionReasons, missed, tierByPgm } = ctx;
  if (!ourTop) return `R${fused.raceNumber} — no ranked runners`;
  const ourTier = tierByPgm.get(ourTop.pgm) ?? "PASS";
  const name = ourTop.horseName ?? `#${ourTop.pgm}`;
  if (!missed) {
    return `R${fused.raceNumber} — ${name} (${ourTier} TOP) won. v3 confirmed.`;
  }
  const lines: string[] = [];
  lines.push(
    `R${fused.raceNumber} — ${name} (${ourTier} TOP, finished ${ordinal(ourTopFinish)})`,
  );
  if (demotionReasons.length) {
    lines.push("  Should have demoted because:");
    for (const r of demotionReasons) lines.push(`   - ${r}`);
  }
  if (winner) {
    const wt = tierByPgm.get(winner.pgm) ?? "PASS";
    const wn = winner.horseName ?? `#${winner.pgm}`;
    lines.push(`  Winner was ${wn} (${wt}, ${wt === "PASS" || wt === "RECON" ? "under-tiered" : "available"}):`);
    for (const f of winnerFlags) lines.push(`   - ${FEATURE_LABEL[f.feature]} ${f.score} — ${f.note}`);
  }
  return lines.join("\n");
}

function ordinal(n: number | null): string {
  if (n == null) return "off the board";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// Replay: re-run the whole card under v3, count how many of the actual misses
// the v3 path now tops the real winner (i.e. v3 would have caught the miss).
// finishByRace is keyed by raceNumber.
export function replayCard(
  fusedRaces: FusionV3Race[],
  finishByRace: Record<number, FinishOrder>,
): ReplayResult {
  const races = fusedRaces.map((fr) => attributeRace(fr, finishByRace[fr.raceNumber] ?? {}));
  const caught: number[] = [];
  for (const fr of fusedRaces) {
    const finish = finishByRace[fr.raceNumber];
    if (!finish) continue;
    const winnerPgm = Object.keys(finish).find((p) => finish[p] === 1);
    if (!winnerPgm) continue;
    // v3 "catches" the race when its top-ranked composite IS the actual winner.
    const v3Top = [...fr.runners].sort((a, b) => a.rank - b.rank)[0];
    if (v3Top && v3Top.pgm === winnerPgm) caught.push(fr.raceNumber);
  }
  return {
    races,
    totalRaces: fusedRaces.length,
    missesCaught: caught.length,
    caughtRaceNumbers: caught,
  };
}
