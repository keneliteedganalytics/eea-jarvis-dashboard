/**
 * Track Bias Detector — v3.2
 *
 * Computes live post-position and running-style bias from graded races on a card.
 * Mirrors the Python implementation in handicapping/track_bias_detector.py.
 *
 * Activates after MIN_RACES_FOR_SIGNAL graded races. Identifies "hot" post
 * positions (>=45% win rate) and "dead" post positions (0 wins after 4+ races).
 * Style bias (FRONT vs CLOSER) activates when >=60% of winners share a style.
 *
 * NOTE: PP is currently inferred from the winning program number (most tracks
 *       align PP with program). True PP from past performance data is a v3.3
 *       enhancement.
 */

export const HOT_PP_THRESHOLD = 0.45;
export const MIN_RACES_FOR_SIGNAL = 3;
export const MIN_RACES_FOR_DEAD_PP = 4;
export const STYLE_BIAS_THRESHOLD = 0.6;

export const PE_FRONT_THRESHOLD = 2.9;
export const PE_STALKER_MAX = 6.0;

export type RunningStyle = "FRONT" | "STALKER" | "CLOSER";

export interface GradedRaceInput {
  raceNumber: number;
  winnerPp: string;
  winnerPaceEarly?: number | null; // Optional — falls back to STALKER when missing
  allPps?: string[];
}

export interface BiasState {
  active: boolean;
  nGraded: number;
  hotPps: string[];
  deadPps: string[];
  ppWinRates: Record<string, number>;
  styleBias: RunningStyle | null;
  styleDistribution: Record<string, number>;
  confidence: number;
  thresholds: {
    hotPpThreshold: number;
    minRacesForSignal: number;
    minRacesForDeadPp: number;
    styleBiasThreshold: number;
  };
}

export function classifyStyle(pe: number | null | undefined): RunningStyle {
  if (pe == null) return "STALKER";
  if (pe < PE_FRONT_THRESHOLD) return "FRONT";
  if (pe <= PE_STALKER_MAX) return "STALKER";
  return "CLOSER";
}

export function detectBias(gradedRaces: GradedRaceInput[]): BiasState {
  const n = gradedRaces.length;
  const baseState: BiasState = {
    active: false,
    nGraded: n,
    hotPps: [],
    deadPps: [],
    ppWinRates: {},
    styleBias: null,
    styleDistribution: {},
    confidence: 0,
    thresholds: {
      hotPpThreshold: HOT_PP_THRESHOLD,
      minRacesForSignal: MIN_RACES_FOR_SIGNAL,
      minRacesForDeadPp: MIN_RACES_FOR_DEAD_PP,
      styleBiasThreshold: STYLE_BIAS_THRESHOLD,
    },
  };

  if (n < MIN_RACES_FOR_SIGNAL) return baseState;

  // PP wins
  const ppWins: Record<string, number> = {};
  const allPpsSeen = new Set<string>();
  for (const g of gradedRaces) {
    const wp = String(g.winnerPp);
    ppWins[wp] = (ppWins[wp] || 0) + 1;
    for (const pp of g.allPps || []) allPpsSeen.add(String(pp));
  }
  const universe = new Set<string>([
    ...Array.from(allPpsSeen),
    ...Object.keys(ppWins),
  ]);
  const ppWinRates: Record<string, number> = {};
  for (const pp of Array.from(universe)) ppWinRates[pp] = (ppWins[pp] || 0) / n;
  baseState.ppWinRates = ppWinRates;

  // Hot PPs
  baseState.hotPps = Object.entries(ppWinRates)
    .filter(([, r]) => r >= HOT_PP_THRESHOLD)
    .sort(([, a], [, b]) => b - a)
    .map(([pp]) => pp);

  // Dead PPs
  if (n >= MIN_RACES_FOR_DEAD_PP) {
    baseState.deadPps = Array.from(allPpsSeen)
      .filter((pp) => (ppWinRates[pp] || 0) === 0)
      .sort();
  }

  // Style distribution
  const styles = gradedRaces.map((g) => classifyStyle(g.winnerPaceEarly));
  const styleCounts: Record<string, number> = {};
  for (const s of styles) styleCounts[s] = (styleCounts[s] || 0) + 1;
  for (const [s, c] of Object.entries(styleCounts)) {
    baseState.styleDistribution[s] = c / n;
  }
  for (const [s, rate] of Object.entries(baseState.styleDistribution)) {
    if (rate >= STYLE_BIAS_THRESHOLD) {
      baseState.styleBias = s as RunningStyle;
      break;
    }
  }

  baseState.active = baseState.hotPps.length > 0 || baseState.styleBias !== null;

  if (baseState.active) {
    const maxPp = Math.max(0, ...Object.values(ppWinRates));
    const maxStyle = Math.max(0, ...Object.values(baseState.styleDistribution));
    baseState.confidence = Math.min(0.85, ((maxPp + maxStyle) / 2) * (n / 7));
  }

  return baseState;
}

export interface HorseInput {
  pp?: string | null;
  pgm?: string | null;
  paceEarly?: number | null;
}

export interface BiasAdjustment {
  total: number;
  components: Record<string, number>;
}

export const TRACK_BIAS_HOT_PP_BONUS = 1.5;
export const TRACK_BIAS_DEAD_PP_PENALTY = -0.5;
export const STYLE_BIAS_CLOSER_BONUS = 1.0;
export const STYLE_BIAS_FRONT_PENALTY = -1.0;
export const STYLE_BIAS_FRONT_BONUS = 1.0;
export const STYLE_BIAS_CLOSER_PENALTY = -1.0;

export function biasAdjustment(
  horse: HorseInput,
  state: BiasState,
): BiasAdjustment {
  const out: BiasAdjustment = { total: 0, components: {} };
  if (!state.active) return out;
  const pp = String(horse.pp ?? horse.pgm ?? "");
  if (state.hotPps.includes(pp)) out.components.hotPpBonus = TRACK_BIAS_HOT_PP_BONUS;
  if (state.deadPps.includes(pp)) out.components.deadPpPenalty = TRACK_BIAS_DEAD_PP_PENALTY;
  const style = classifyStyle(horse.paceEarly ?? null);
  if (state.styleBias === "CLOSER") {
    if (style === "CLOSER") out.components.styleCloserBonus = STYLE_BIAS_CLOSER_BONUS;
    else if (style === "FRONT") out.components.styleFrontPenalty = STYLE_BIAS_FRONT_PENALTY;
  } else if (state.styleBias === "FRONT") {
    if (style === "FRONT") out.components.styleFrontBonus = STYLE_BIAS_FRONT_BONUS;
    else if (style === "CLOSER") out.components.styleCloserPenalty = STYLE_BIAS_CLOSER_PENALTY;
  }
  out.total = Object.values(out.components).reduce((a, b) => a + b, 0);
  return out;
}
