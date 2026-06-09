// Brisnet Ultimate PP "deep field" model + parser (PR #28b).
//
// The DRM .DR2 binary path (parsers/brisnet-drm.ts) reliably exposes only a thin
// header slice — Prime Power, run style, pars, best speed, pedigree names. The
// Ultimate PP carries far more: per-start pace (E1/E2/LP), class (RR/CR), trip
// comments + race shapes, the Track Bias sheet, J/T L60 + trainer 3yr angles,
// workouts, and the Ultimate Race Summary derived block (Avg Dist/Surf, ACL,
// Best Pace, Final Speed curve, layoff dots). Per brisnet_ultimate_pp_spec.md
// the fusion engine MUST use these where available.
//
// Provider auth is broken upstream (Equibase Incapsula bot-wall; Brisnet
// POST→405/Akamai — see docs/pr27-ingest-debug-report.md), so this PR ships the
// FULL schema + parser + features + tests on FIXTURE data. The fixtures are
// anonymized, hand-normalized representations of a parsed Ultimate PP card, in
// the JSON shape a restored ingest would produce. The model + parser are the
// contract; when live ingest returns, the binary extractor populates this same
// shape and the features light up unchanged.
//
// Every field is nullable. Features gate on presence (`if (x == null) return
// null`) rather than faking values, so a thin card simply yields fewer signals
// instead of biased ones.

// ── Sample-size flags (Ultimate Race Summary) ───────────────────────────────
// asterisks = ≥2 races at/near today's dist & surface within 90 days (strong)
// none      = exactly one race in last 90 days (medium)
// parens    = race used was >90 days ago (weak)
export type SampleFlag = "ASTERISK" | "NONE" | "PARENS";

export type RunStyle = "E" | "E/P" | "P" | "S" | "NA";
export type BiasScope = "MEET" | "WEEK";

// One of the last-10 past-performance lines.
export interface DeepPastLine {
  date: string | null; // ISO YYYY-MM-DD
  track: string | null;
  raceNum: number | null;
  surface: string | null; // DIRT / INNER_DIRT / TURF / INNER_TURF / TURF_TO_DIRT / AW
  distanceFurlongs: number | null;
  condition: string | null; // ft/gd/my/sy/wf/fm/yl/sf/hy/sl
  raceType: string | null;
  rr: number | null; // Race Rating — quality of field faced
  cr: number | null; // Class Rating — performance vs that field
  e1: number | null;
  e2: number | null;
  lp: number | null;
  spd: number | null;
  post: number | null;
  // position + lengths at each point of call (lengths behind leader; +ahead)
  stPos: number | null;
  stLengths: number | null;
  c1Pos: number | null;
  c1Lengths: number | null;
  c2Pos: number | null;
  c2Lengths: number | null;
  strPos: number | null;
  strLengths: number | null;
  finPos: number | null;
  finLengths: number | null;
  jockey: string | null;
  weight: number | null;
  med: string | null; // L / B / LB
  equip: string | null; // b / f / bf
  odds: number | null;
  top3: Array<{ name: string; margin: number | null; bold: boolean; italic: boolean }>;
  comment: string | null; // trip narrative
  fieldSize: number | null;
  raceShape1c: number | null;
  raceShape2c: number | null;
}

export interface DeepWorkout {
  date: string | null;
  bullet: boolean;
  track: string | null;
  trainingTrack: boolean;
  turf: boolean;
  aroundDogs: boolean;
  distanceFurlongs: number | null;
  condition: string | null;
  time: number | null; // seconds
  style: "B" | "H" | null; // breezing / handily
  fromGate: boolean;
  rankPosition: number | null;
  rankTotal: number | null;
}

export interface JockeyBlock {
  meetMounts: number | null;
  meet1: number | null;
  meet2: number | null;
  meet3: number | null;
  meetWinPct: number | null;
  yearMounts: number | null;
  yearWinPct: number | null;
  yearItmPct: number | null;
  yearRoi: number | null;
  runStyleMounts: number | null;
  runStyleWinPct: number | null;
  runStyleItmPct: number | null;
  runStyleRoi: number | null;
  // ⭐ L60 with today's trainer
  trnL60Mounts: number | null;
  trnL60WinPct: number | null;
  trnL60ItmPct: number | null;
  trnL60Roi: number | null;
  distSurfMounts: number | null;
  distSurfWinPct: number | null;
  distSurfItmPct: number | null;
  distSurfRoi: number | null;
}

export interface TrainerAngle {
  starts: number | null;
  winPct: number | null;
  itmPct: number | null;
  roi: number | null;
}

export interface TrainerBlock {
  meetStarts: number | null;
  meet1: number | null;
  meet2: number | null;
  meet3: number | null;
  meetWinPct: number | null;
  yearStarts: number | null;
  yearWinPct: number | null;
  yearItmPct: number | null;
  yearRoi: number | null;
  // ⭐ today's pertinent angles, 3yr. Keys: layoff, surface_switch, claim,
  // class_drop, class_up, blinkers_on, blinkers_off, dist_up, dist_down,
  // first_lasix, etc. Only angles that fire today are present.
  angles3yr: Record<string, TrainerAngle>;
}

// Per-runner derived block off the Ultimate Race Summary sheet.
export interface RaceSummaryDerived {
  avgDsE1: number | null;
  avgDsE2: number | null;
  avgDsLate: number | null;
  avgDsSpd: number | null;
  avgDsSampleFlag: SampleFlag | null; // ⭐ drives dist_surf_form multiplier
  avgRaceRtng: number | null;
  bestPaceE1: number | null;
  bestPaceE2: number | null;
  bestPaceLp: number | null;
  finalSpd1: number | null; // most recent first
  finalSpd2: number | null;
  finalSpd3: number | null;
  finalSpd4: number | null;
  acl: number | null; // Average Competitive Level
  aclDistSurfMatch: boolean;
  regSpdAvg: number | null;
  prevRr1: number | null;
  prevRr2: number | null;
  prevRr3: number | null;
  mudSpd: number | null;
  daysSinceLr: number | null;
  layoffCount: 0 | 1 | 2 | null; // layoff dots
  speedLastRace: number | null;
  backSpeed: number | null;
  currentClass: number | null;
  avgClassLast3: number | null;
  earlyPaceLastRace: number | null;
  latePaceLastRace: number | null;
}

// Per-runner header block.
export interface DeepRunnerHeader {
  primePower: number | null;
  primePowerRank: number | null;
  runStyle: RunStyle | null;
  earlySpeedPoints: number | null; // 0-8
  pedFast: number | null;
  pedOff: number | null;
  pedDistance: number | null;
  pedTurf: number | null;
  medLasix: "NONE" | "L" | "FIRST_L" | null;
  medBute: boolean;
  blinkers: "NONE" | "ON" | "OFF" | null;
  weightCarried: number | null;
  apprenticeAllowance: number | null;
  denotation: "NONE" | "AE" | "MTO" | null;
  claimPrice: number | null;
  dpi: number | null;
  spi: number | null;
  sireAwd: number | null;
  damSireAwd: number | null;
  sireMudPct: number | null;
  sireMudStarts: number | null;
  sireTurfPct: number | null;
  sireFtsPct: number | null;
  sireFirstTurfPct: number | null;
  // record buckets: [starts, 1, 2, 3, earnings, bestSpd]
  lifeRecord: RunnerRecord | null;
  cyRecord: RunnerRecord | null;
  pyRecord: RunnerRecord | null;
  trackRecord: RunnerRecord | null;
  fstRecord: RunnerRecord | null;
  offRecord: RunnerRecord | null;
  disRecord: RunnerRecord | null;
  trfRecord: RunnerRecord | null;
  awRecord: RunnerRecord | null;
  ownerName: string | null;
}

export interface RunnerRecord {
  starts: number | null;
  first: number | null;
  second: number | null;
  third: number | null;
  earnings: number | null;
  bestSpd: number | null;
}

export interface DeepRunner {
  programNumber: string;
  horseName: string | null;
  sireName: string | null;
  damName: string | null;
  damSireName: string | null;
  mlOdds: number | null;
  header: DeepRunnerHeader;
  jockey: JockeyBlock;
  trainer: TrainerBlock;
  pastLines: DeepPastLine[];
  workouts: DeepWorkout[];
  summary: RaceSummaryDerived;
}

// Per-race Track Bias snapshot (one row per scope).
export interface TrackBiasSnapshot {
  scope: BiasScope;
  surface: string | null;
  distance: string | null;
  numRaces: number | null;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  wirePct: number | null;
  speedBiasPct: number | null;
  wnrAvgBl1c: number | null;
  wnrAvgBl2c: number | null;
  ivE: number | null;
  ivEp: number | null;
  ivP: number | null;
  ivS: number | null;
  pctE: number | null;
  pctEp: number | null;
  pctP: number | null;
  pctS: number | null;
  dominantStyle: RunStyle | null; // ++ marker
  favorableStyles: RunStyle[]; // + markers
  ivRail: number | null;
  iv1_3: number | null;
  iv4_7: number | null;
  iv8plus: number | null;
  pctRail: number | null;
  pct1_3: number | null;
  pct4_7: number | null;
  pct8plus: number | null;
  favorablePosts: string[]; // e.g. ["RAIL", "1_3"]
}

export interface DeepRacePars {
  parE1: number | null;
  parE2Late: number | null;
  parSpd: number | null;
}

export interface DeepRace {
  raceNumber: number;
  conditionsRaw: string | null;
  surface: string | null;
  distanceFurlongs: number | null;
  pars: DeepRacePars;
  bias: TrackBiasSnapshot[]; // MEET + WEEK
  runners: DeepRunner[];
}

export interface DeepCard {
  track: string;
  date: string; // ISO YYYY-MM-DD
  races: DeepRace[];
}

// ── Defaults / builders ──────────────────────────────────────────────────────
// These let the parser fill any field the fixture omits with a typed null, so
// the persistence layer always sees the full shape and features can presence-gate.

function nullRecord(): RunnerRecord {
  return { starts: null, first: null, second: null, third: null, earnings: null, bestSpd: null };
}

function emptyHeader(): DeepRunnerHeader {
  return {
    primePower: null,
    primePowerRank: null,
    runStyle: null,
    earlySpeedPoints: null,
    pedFast: null,
    pedOff: null,
    pedDistance: null,
    pedTurf: null,
    medLasix: null,
    medBute: false,
    blinkers: null,
    weightCarried: null,
    apprenticeAllowance: null,
    denotation: null,
    claimPrice: null,
    dpi: null,
    spi: null,
    sireAwd: null,
    damSireAwd: null,
    sireMudPct: null,
    sireMudStarts: null,
    sireTurfPct: null,
    sireFtsPct: null,
    sireFirstTurfPct: null,
    lifeRecord: null,
    cyRecord: null,
    pyRecord: null,
    trackRecord: null,
    fstRecord: null,
    offRecord: null,
    disRecord: null,
    trfRecord: null,
    awRecord: null,
    ownerName: null,
  };
}

function emptyJockey(): JockeyBlock {
  return {
    meetMounts: null,
    meet1: null,
    meet2: null,
    meet3: null,
    meetWinPct: null,
    yearMounts: null,
    yearWinPct: null,
    yearItmPct: null,
    yearRoi: null,
    runStyleMounts: null,
    runStyleWinPct: null,
    runStyleItmPct: null,
    runStyleRoi: null,
    trnL60Mounts: null,
    trnL60WinPct: null,
    trnL60ItmPct: null,
    trnL60Roi: null,
    distSurfMounts: null,
    distSurfWinPct: null,
    distSurfItmPct: null,
    distSurfRoi: null,
  };
}

function emptyTrainer(): TrainerBlock {
  return {
    meetStarts: null,
    meet1: null,
    meet2: null,
    meet3: null,
    meetWinPct: null,
    yearStarts: null,
    yearWinPct: null,
    yearItmPct: null,
    yearRoi: null,
    angles3yr: {},
  };
}

// Hydrate a partial angles map into full TrainerAngle records (every key typed).
function mergeAngles(
  p: Record<string, DeepPartial<TrainerAngle> | undefined> | undefined,
): Record<string, TrainerAngle> {
  const out: Record<string, TrainerAngle> = {};
  if (!p) return out;
  for (const [k, v] of Object.entries(p)) {
    out[k] = {
      starts: v?.starts ?? null,
      winPct: v?.winPct ?? null,
      itmPct: v?.itmPct ?? null,
      roi: v?.roi ?? null,
    };
  }
  return out;
}

function emptySummary(): RaceSummaryDerived {
  return {
    avgDsE1: null,
    avgDsE2: null,
    avgDsLate: null,
    avgDsSpd: null,
    avgDsSampleFlag: null,
    avgRaceRtng: null,
    bestPaceE1: null,
    bestPaceE2: null,
    bestPaceLp: null,
    finalSpd1: null,
    finalSpd2: null,
    finalSpd3: null,
    finalSpd4: null,
    acl: null,
    aclDistSurfMatch: false,
    regSpdAvg: null,
    prevRr1: null,
    prevRr2: null,
    prevRr3: null,
    mudSpd: null,
    daysSinceLr: null,
    layoffCount: null,
    speedLastRace: null,
    backSpeed: null,
    currentClass: null,
    avgClassLast3: null,
    earlyPaceLastRace: null,
    latePaceLastRace: null,
  };
}

// Deep-merge a partial into a full default, recursively for the nested blocks.
// Arrays replace wholesale; objects merge key-by-key. This is what lets a
// fixture specify only the fields a given runner actually carries.
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer _U>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function mergeRecord(p: DeepPartial<RunnerRecord> | null | undefined): RunnerRecord | null {
  if (p == null) return null;
  return { ...nullRecord(), ...p };
}

function mergeHeader(p: DeepPartial<DeepRunnerHeader> | undefined): DeepRunnerHeader {
  const base = emptyHeader();
  if (!p) return base;
  const recordKeys: (keyof DeepRunnerHeader)[] = [
    "lifeRecord", "cyRecord", "pyRecord", "trackRecord",
    "fstRecord", "offRecord", "disRecord", "trfRecord", "awRecord",
  ];
  const out = { ...base, ...(p as DeepRunnerHeader) };
  for (const k of recordKeys) {
    out[k] = mergeRecord((p as Record<string, unknown>)[k] as DeepPartial<RunnerRecord>) as never;
  }
  return out;
}

function mergePastLine(p: DeepPartial<DeepPastLine>): DeepPastLine {
  return {
    date: null, track: null, raceNum: null, surface: null, distanceFurlongs: null,
    condition: null, raceType: null, rr: null, cr: null, e1: null, e2: null,
    lp: null, spd: null, post: null, stPos: null, stLengths: null, c1Pos: null,
    c1Lengths: null, c2Pos: null, c2Lengths: null, strPos: null, strLengths: null,
    finPos: null, finLengths: null, jockey: null, weight: null, med: null,
    equip: null, odds: null, top3: [], comment: null, fieldSize: null,
    raceShape1c: null, raceShape2c: null,
    ...p,
  } as DeepPastLine;
}

function mergeWorkout(p: DeepPartial<DeepWorkout>): DeepWorkout {
  return {
    date: null, bullet: false, track: null, trainingTrack: false, turf: false,
    aroundDogs: false, distanceFurlongs: null, condition: null, time: null,
    style: null, fromGate: false, rankPosition: null, rankTotal: null,
    ...p,
  } as DeepWorkout;
}

function mergeBias(p: DeepPartial<TrackBiasSnapshot>): TrackBiasSnapshot {
  return {
    scope: "MEET", surface: null, distance: null, numRaces: null,
    dateRangeStart: null, dateRangeEnd: null, wirePct: null, speedBiasPct: null,
    wnrAvgBl1c: null, wnrAvgBl2c: null, ivE: null, ivEp: null, ivP: null, ivS: null,
    pctE: null, pctEp: null, pctP: null, pctS: null, dominantStyle: null,
    favorableStyles: [], ivRail: null, iv1_3: null, iv4_7: null, iv8plus: null,
    pctRail: null, pct1_3: null, pct4_7: null, pct8plus: null, favorablePosts: [],
    ...p,
  } as TrackBiasSnapshot;
}

// ── Fixture shape ────────────────────────────────────────────────────────────
// The on-disk fixture is a DeepPartial of the card: every leaf optional. The
// parser hydrates it into a full DeepCard. This is the same shape a restored
// live ingest would emit (the binary extractor would build it field-by-field).
export interface DeepCardFixture {
  track: string;
  date: string;
  races: Array<{
    raceNumber: number;
    conditionsRaw?: string | null;
    surface?: string | null;
    distanceFurlongs?: number | null;
    pars?: DeepPartial<DeepRacePars>;
    bias?: DeepPartial<TrackBiasSnapshot>[];
    runners: Array<{
      programNumber: string;
      horseName?: string | null;
      sireName?: string | null;
      damName?: string | null;
      damSireName?: string | null;
      mlOdds?: number | null;
      header?: DeepPartial<DeepRunnerHeader>;
      jockey?: DeepPartial<JockeyBlock>;
      trainer?: DeepPartial<TrainerBlock>;
      pastLines?: DeepPartial<DeepPastLine>[];
      workouts?: DeepPartial<DeepWorkout>[];
      summary?: DeepPartial<RaceSummaryDerived>;
    }>;
  }>;
}

// Parse (hydrate) a deep-card fixture into the full typed model. Pure; no I/O.
export function parseDeepCard(fixture: DeepCardFixture): DeepCard {
  return {
    track: fixture.track,
    date: fixture.date,
    races: fixture.races.map((r) => ({
      raceNumber: r.raceNumber,
      conditionsRaw: r.conditionsRaw ?? null,
      surface: r.surface ?? null,
      distanceFurlongs: r.distanceFurlongs ?? null,
      pars: {
        parE1: r.pars?.parE1 ?? null,
        parE2Late: r.pars?.parE2Late ?? null,
        parSpd: r.pars?.parSpd ?? null,
      },
      bias: (r.bias ?? []).map(mergeBias),
      runners: r.runners.map((h) => ({
        programNumber: h.programNumber,
        horseName: h.horseName ?? null,
        sireName: h.sireName ?? null,
        damName: h.damName ?? null,
        damSireName: h.damSireName ?? null,
        mlOdds: h.mlOdds ?? null,
        header: mergeHeader(h.header),
        jockey: { ...emptyJockey(), ...(h.jockey ?? {}) },
        trainer: {
          ...emptyTrainer(),
          ...(h.trainer ?? {}),
          angles3yr: mergeAngles(h.trainer?.angles3yr),
        },
        pastLines: (h.pastLines ?? []).map(mergePastLine),
        workouts: (h.workouts ?? []).map(mergeWorkout),
        summary: { ...emptySummary(), ...(h.summary ?? {}) },
      })),
    })),
  };
}

// Parse a deep-card fixture from a JSON string (the on-disk fixture format).
export function parseDeepCardJson(json: string): DeepCard {
  return parseDeepCard(JSON.parse(json) as DeepCardFixture);
}
