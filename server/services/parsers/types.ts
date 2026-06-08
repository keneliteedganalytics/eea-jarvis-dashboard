// Shared structured shapes produced by the PDF parsers and consumed by fusion.

export interface RaceConditions {
  type: string; // "MCL", "ALW", "STK", "MSW", "OC", ...
  raw: string; // original conditions text
  purse?: number;
  distance?: string; // "6F", "1 1/16M"
  surface?: string; // "DIRT" | "TURF"
  ageRestriction?: string;
  sexRestriction?: string;
  claimingPrice?: number;
}

export interface BrisnetPace {
  e1Last?: number | null;
  e2Last?: number | null;
  lpLast?: number | null;
  e1Avg3?: number | null;
  e2Avg3?: number | null;
  lpAvg3?: number | null;
}

export interface BrisnetHorse {
  pgm: string;
  name: string;
  ml?: string | null;
  jockey?: string | null;
  trainer?: string | null;
  dsl?: number | null;
  primePower?: number | null;
  classRating?: number | null;
  speedLast?: number | null;
  bestSpeedDist?: number | null;
  // Wet-track win % (Brisnet "Wet(##)"). Optional — present only when the PP
  // carries it. Used by the PR #18 weather factor to boost proven mudders.
  wetWinPct?: number | null;
  pace: BrisnetPace;
  sire?: { name?: string; winPctOverall?: number | null } | null;
  dam?: { name?: string } | null;
  // Dam's sire (broodmare sire). Surfaced for the Phase 2 bloodstock factor;
  // joined in from the DRM .DR2 pedigree fields when available.
  damSire?: { name?: string } | null;
  // Lifetime starts, used to detect first-time / lightly-raced starters where
  // pedigree carries more weight. Null when the PP doesn't expose it.
  lifetimeStarts?: number | null;
  trainerAngles?: string[];
  quickPlayComment?: string | null;
}

export interface BrisnetRace {
  raceNumber: number;
  conditions: RaceConditions;
  postTimeRaw?: string | null; // raw local post time token, if present
  horses: BrisnetHorse[];
}

export interface BrisnetCard {
  track: string;
  date: string;
  races: BrisnetRace[];
}

export interface EquibaseHorse {
  pgm: string;
  postPos?: number | null;
  postPosWinPct?: number | null;
  name: string;
  classRating?: number | null;
  paceLast?: number | null;
  paceAvg3?: number | null;
  paceHiLife?: number | null;
  // maiden-only sire/dam foal stats
  sireFoalsAvgPace?: number | null;
  sireFoalsWinPct?: number | null;
  sireStudFee?: number | null;
  damFoalsAvgPace?: number | null;
  damFoalsWinPct?: number | null;
  speedLast?: number | null;
  speedAvg3?: number | null;
  speedHiLife?: number | null;
  // Wet-track win % (Equibase off-track record). Optional. See BrisnetHorse.wetWinPct.
  wetWinPct?: number | null;
  jockey?: string | null;
  trainer?: string | null;
  jockeyPct?: number | null;
  trainerPct?: number | null;
  jtPct?: number | null;
}

export interface EquibaseRace {
  raceNumber: number;
  raceRating?: number | null;
  isMaiden: boolean;
  conditionsRaw?: string;
  postTimeRaw?: string | null; // raw "Post Time:" line text, if present
  horses: EquibaseHorse[];
}

export interface EquibaseCard {
  track: string;
  date: string;
  races: EquibaseRace[];
}
