// EEA v4 LIVE RATING — TypeScript port of docs/handicapping-engine/v4/eea_v4_rate.py
//
// Grades a card with the v4-lock-2026-06-12 weights + tier thresholds. Ranks
// each horse within its race per feature, converts ranks to (n−rank+1)/n
// rank-scores, takes the weighted sum × 100 as the composite, and assigns the
// top-composite horse (the anchor) a tier. The RECON stamp surfaces
// lower-conviction races rather than silently skipping them.
//
// Accepts the three raw card_data.json schemas the Python CLI handles
// (Belmont nested-brisnet, Churchill flat, evaluated all_horses) plus the
// dashboard's own CardWithRaces shape — DB races carry no per-horse feature
// columns, so those grade to PASS with an explanatory note instead of throwing.

export const V4_VERSION = "v4-lock-2026-06-12";

// Locked weights (normalized, sum = 1). DO NOT tweak — see DESIGN_SPEC §9.
export const V4_WEIGHTS = {
  prime: 0.209,
  class: 0.167,
  spd3: 0.153,
  pc3: 0.194,
  jt: 0.139,
  ml: 0.139,
} as const;

export type V4Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

export interface V4Grade {
  race: number | string;
  anchorPp: string;
  anchorName: string;
  anchorMl: string;
  tier: V4Tier;
  composite: number;
  confirmsTop3: number;
  ranks: { prime: number; class: number; spd3: number; pc3: number; jt: number; ml: number };
  recommendation: string;
  compositeTop3: Array<{ pp: string; name: string; composite: number; ml: string }>;
  fieldSize: number;
}

const FEATURES = ["prime", "class", "spd3", "pc3", "jt", "ml"] as const;
type Feature = (typeof FEATURES)[number];

// Canonical per-horse form after normalization from any input schema.
interface NormHorse {
  pp: string;
  name: string;
  primePower: number;
  classRating: number;
  speedAvg3: number;
  paceAvg3: number;
  jtPct: number;
  mlOdds: string;
  mlDec: number;
}

// Convert "6/5", "6-5", or "5/1" to a decimal payout-per-$1. Defaults to 99.0
// on any parse failure, matching the Python reference.
export function oddsToDec(input: unknown): number {
  const s = String(input ?? "").replace(/-/g, "/");
  if (s.includes("/")) {
    const [a, b] = s.split("/");
    const num = Number(a);
    const den = Number(b);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 99.0;
    return num / den;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : 99.0;
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Parse a JT percentage that may arrive as 23, "23", or "23%".
function pctToNum(v: unknown): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/%$/, ""));
  return Number.isFinite(n) ? n : 0;
}

type RawHorse = Record<string, unknown>;

// Normalize one horse from any supported input schema into v4's canonical form.
// Mirrors Python normalize_horse(): brisnet-nested → evaluated → flat fallback.
function normalizeHorse(h: RawHorse): NormHorse {
  let prime: number;
  let cls: number;
  let spd3: number;
  let pc3: number;
  let jt: number;
  let ml: string;
  let name: string;

  if ("brisnet" in h && h.brisnet && typeof h.brisnet === "object") {
    // Belmont card_data.json: nested brisnet + equibase objects.
    const bris = h.brisnet as RawHorse;
    const eq = (h.equibase as RawHorse) ?? {};
    prime = toNum(bris.prime_power);
    cls = toNum(eq.class_rating);
    spd3 = toNum(eq.spd_avg3);
    pc3 = toNum(eq.pace_avg3);
    jt = pctToNum(eq.jt_pct);
    ml = String(h.mlOdds ?? "99-1");
    name = String(h.name ?? "");
  } else if ("post_pos" in h && "horse" in h) {
    // Evaluated (6/12) schema.
    prime = toNum(h.prime_power);
    cls = toNum(h.class_rating);
    spd3 = toNum(h.spd_avg3);
    pc3 = toNum(h.pace_avg3);
    jt = pctToNum(h.jt_pct);
    ml = String(h.ml_odds ?? "99/1");
    name = String(h.horse ?? "");
  } else {
    // Flat (Churchill card_data.json) + evaluated all_horses fallback.
    prime = toNum(h.brisnet_prime_power ?? h.prime_power);
    cls = toNum(h.equibase_class_rating ?? h.class_rating);
    spd3 = toNum(h.equibase_speed_last3 ?? h.spd_avg3);
    pc3 = toNum(h.equibase_pace_avg_last3 ?? h.pace_avg3);
    jt = pctToNum(h.jt_itm_pct ?? h.jt_pct);
    ml = String(h.ml_odds ?? "99/1");
    name = String(h.name ?? h.horse ?? "");
  }

  const ml_str = ml || "99/1";
  return {
    pp: String(h.pgm ?? h.post_pos ?? ""),
    name,
    primePower: prime,
    classRating: cls,
    speedAvg3: spd3,
    paceAvg3: pc3,
    jtPct: jt,
    mlOdds: ml_str,
    mlDec: oddsToDec(ml_str),
  };
}

// Return { pp: rank } with 1 = best. Higher value ranks first unless
// `ascending` (ML decimal: lower = chalk = better).
function rankWithin(
  horses: NormHorse[],
  selector: (h: NormHorse) => number,
  ascending = false,
): Record<string, number> {
  const sorted = [...horses].sort((a, b) =>
    ascending ? selector(a) - selector(b) : selector(b) - selector(a),
  );
  const out: Record<string, number> = {};
  sorted.forEach((h, i) => {
    out[h.pp] = i + 1;
  });
  return out;
}

interface CompositeScore {
  composite: number;
  ranks: Record<Feature, number>;
  name: string;
  mlOdds: string;
}

const SELECTORS: Record<Feature, { sel: (h: NormHorse) => number; ascending: boolean }> = {
  prime: { sel: (h) => h.primePower, ascending: false },
  class: { sel: (h) => h.classRating, ascending: false },
  spd3: { sel: (h) => h.speedAvg3, ascending: false },
  pc3: { sel: (h) => h.paceAvg3, ascending: false },
  jt: { sel: (h) => h.jtPct, ascending: false },
  ml: { sel: (h) => h.mlDec, ascending: true },
};

function computeComposite(horses: NormHorse[]): Record<string, CompositeScore> {
  const n = horses.length;
  if (n === 0) return {};

  const rk = {} as Record<Feature, Record<string, number>>;
  for (const feat of FEATURES) {
    rk[feat] = rankWithin(horses, SELECTORS[feat].sel, SELECTORS[feat].ascending);
  }

  const scores: Record<string, CompositeScore> = {};
  for (const h of horses) {
    let composite = 0;
    const ranks = {} as Record<Feature, number>;
    for (const feat of FEATURES) {
      const r = rk[feat][h.pp] ?? n;
      const rankScore = (n - r + 1) / n;
      composite += V4_WEIGHTS[feat] * rankScore;
      ranks[feat] = r;
    }
    scores[h.pp] = {
      composite: Math.round(composite * 100 * 10) / 10,
      ranks,
      name: h.name,
      mlOdds: h.mlOdds,
    };
  }
  return scores;
}

interface TierResult {
  anchorPp: string;
  anchorName: string;
  anchorMl: string;
  tier: V4Tier;
  composite: number;
  confirmsTop3: number;
  ranks: Record<Feature, number>;
  recommendation: string;
  compositeTop3: Array<{ pp: string; name: string; composite: number; ml: string }>;
}

function assignTier(scores: Record<string, CompositeScore>): TierResult | null {
  const pps = Object.keys(scores);
  if (pps.length === 0) return null;

  const sorted = [...pps].sort((a, b) => scores[b].composite - scores[a].composite);
  const anchorPp = sorted[0];
  const a = scores[anchorPp];
  const comp = a.composite;
  const rk = a.ranks;
  const confirms = FEATURES.reduce((acc, f) => acc + (rk[f] <= 3 ? 1 : 0), 0);

  let tier: V4Tier;
  let rec: string;
  if (comp >= 90 && rk.prime === 1 && rk.pc3 <= 2) {
    tier = "SNIPER";
    rec = "Lock anchor. $25 WIN + $20 EXA key over composite top-3.";
  } else if (comp >= 80 && rk.prime <= 2) {
    tier = "EDGE";
    rec = "Strong anchor. $15 WIN + $10 EXA key over composite top-3.";
  } else if (comp >= 70 && rk.prime <= 3) {
    tier = "DUAL";
    rec = "Two-horse exotic. $10 EXA box anchor with composite #2. NO WIN.";
  } else if (comp >= 60 || (rk.prime <= 3 && confirms >= 2)) {
    tier = "RECON";
    rec = "RECON STAMP — lower conviction. $2–$5 EXA box only. NO WIN. Watch live odds.";
  } else {
    tier = "PASS";
    rec = "Skip race. No anchor meets confidence threshold.";
  }

  return {
    anchorPp,
    anchorName: a.name,
    anchorMl: a.mlOdds,
    tier,
    composite: comp,
    confirmsTop3: confirms,
    ranks: rk,
    recommendation: rec,
    compositeTop3: sorted.slice(0, 3).map((p) => ({
      pp: p,
      name: scores[p].name,
      composite: scores[p].composite,
      ml: scores[p].mlOdds,
    })),
  };
}

// A race that carried no gradeable horse features (e.g. a DB race row).
function passGrade(race: number | string, fieldSize: number, note: string): V4Grade {
  return {
    race,
    anchorPp: "",
    anchorName: "",
    anchorMl: "",
    tier: "PASS",
    composite: 0,
    confirmsTop3: 0,
    ranks: { prime: 0, class: 0, spd3: 0, pc3: 0, jt: 0, ml: 0 },
    recommendation: note,
    compositeTop3: [],
    fieldSize,
  };
}

type RawRace = Record<string, unknown>;
type RawCard = { races?: RawRace[] } & Record<string, unknown>;

// True when a horse carries at least one v4 feature key in some recognized
// schema. DB race rows (flattened pgm picks) have none, so they grade to PASS.
function hasGradeableFeatures(horses: RawHorse[]): boolean {
  return horses.some(
    (h) =>
      ("brisnet" in h && !!h.brisnet) ||
      "prime_power" in h ||
      "brisnet_prime_power" in h ||
      "class_rating" in h ||
      "equibase_class_rating" in h,
  );
}

// Grade an entire card. Accepts any of the supported raw schemas; returns one
// V4Grade per race. Races with no gradeable horses are stamped PASS rather than
// dropped, so the caller always gets a full slate.
export function gradeCard(card: unknown): V4Grade[] {
  const c = (card ?? {}) as RawCard;
  const races = Array.isArray(c.races) ? c.races : [];
  const out: V4Grade[] = [];

  for (const r of races) {
    const rn = (r.raceNumber ?? r.race ?? r.race_number) as number | string;
    const rawHorses = (r.runners ?? r.horses ?? r.all_horses ?? []) as RawHorse[];

    if (!Array.isArray(rawHorses) || rawHorses.length === 0) {
      out.push(passGrade(rn, 0, "No horse data in race — not gradeable by v4."));
      continue;
    }
    if (!hasGradeableFeatures(rawHorses)) {
      out.push(
        passGrade(
          rn,
          rawHorses.length,
          "Race has no v4 feature inputs (prime/class/speed/pace) — grade from raw card_data.json.",
        ),
      );
      continue;
    }

    const horses = rawHorses.map(normalizeHorse);
    const scores = computeComposite(horses);
    const tier = assignTier(scores);
    if (tier === null) {
      out.push(passGrade(rn, horses.length, "Scoring failed — no anchor."));
      continue;
    }
    out.push({ race: rn, fieldSize: horses.length, ...tier });
  }

  return out;
}
