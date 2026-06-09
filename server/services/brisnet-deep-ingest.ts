// Brisnet deep-field persistence (PR #28b).
//
// Upserts a parsed DeepCard (parsers/brisnet-deep.ts) into the deep columns +
// JSON blocks added to brisnet_horse_data, plus brisnet_race_bias and
// brisnet_race_pars. Idempotent: keyed on (race_date, track_code, race_number,
// program_number) for runners and (…, scope) for bias, so a re-run replaces in
// place. Mirrors persistCard() in brisnet-ingest.ts but for the deep schema.
//
// The Equibase cross-check rule (spec §2): this module NEVER overwrites the
// Brisnet-only deep columns from Equibase; Equibase remains a SPD/final-position
// sanity source only, handled in its own ingest path. We only write here.

import { sqlite } from "../db";
import type {
  DeepCard,
  DeepRace,
  DeepRunner,
  DeepRacePars,
  TrackBiasSnapshot,
  RunnerRecord,
  RunStyle,
} from "./parsers/brisnet-deep";

function j(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

function recordJson(r: RunnerRecord | null): string | null {
  return r == null ? null : JSON.stringify(r);
}

// Upsert every runner of a deep card into brisnet_horse_data's deep columns.
// The base row may already exist from the DRM path (sharing the unique key); we
// COALESCE-free overwrite the deep columns we own but leave the DRM-owned
// run_style/prime_power/best_speed untouched unless the deep card carries them.
function upsertRunner(
  isoDate: string,
  trackCode: string,
  raceNumber: number,
  h: DeepRunner,
  ingestedAt: string,
): void {
  const hd = h.header;
  // Ensure a row exists (insert minimal if absent), then update deep columns.
  sqlite
    .prepare(
      `INSERT INTO brisnet_horse_data
         (race_date, track_code, race_number, program_number, raw_row, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (race_date, track_code, race_number, program_number)
       DO NOTHING`,
    )
    .run(isoDate, trackCode, raceNumber, h.programNumber, "[]", ingestedAt);

  sqlite
    .prepare(
      `UPDATE brisnet_horse_data SET
         horse_name = COALESCE(?, horse_name),
         sire_name = COALESCE(?, sire_name),
         dam_name = COALESCE(?, dam_name),
         dam_sire_name = COALESCE(?, dam_sire_name),
         prime_power = COALESCE(?, prime_power),
         run_style = COALESCE(?, run_style),
         ml_odds_deep = ?,
         prime_power_rank = ?,
         early_speed_points = ?,
         ped_fast = ?, ped_off = ?, ped_distance = ?, ped_turf = ?,
         med_lasix = ?, med_bute = ?, blinkers = ?,
         weight_carried = ?, apprentice_allowance = ?,
         denotation = ?, claim_price = ?,
         dpi = ?, spi = ?, sire_awd = ?, dam_sire_awd = ?,
         sire_mud_pct = ?, sire_mud_starts = ?, sire_turf_pct = ?,
         sire_fts_pct = ?, sire_first_turf_pct = ?,
         owner_name = ?,
         life_record = ?, cy_record = ?, py_record = ?, track_record = ?,
         fst_record = ?, off_record = ?, dis_record = ?, trf_record = ?, aw_record = ?,
         jockey_block = ?, trainer_block = ?,
         past_lines = ?, workouts = ?, race_summary = ?,
         ingested_at = ?
       WHERE race_date = ? AND track_code = ? AND race_number = ? AND program_number = ?`,
    )
    .run(
      h.horseName,
      h.sireName,
      h.damName,
      h.damSireName,
      hd.primePower,
      hd.runStyle,
      h.mlOdds,
      hd.primePowerRank,
      hd.earlySpeedPoints,
      hd.pedFast, hd.pedOff, hd.pedDistance, hd.pedTurf,
      hd.medLasix, hd.medBute ? 1 : 0, hd.blinkers,
      hd.weightCarried, hd.apprenticeAllowance,
      hd.denotation, hd.claimPrice,
      hd.dpi, hd.spi, hd.sireAwd, hd.damSireAwd,
      hd.sireMudPct, hd.sireMudStarts, hd.sireTurfPct,
      hd.sireFtsPct, hd.sireFirstTurfPct,
      hd.ownerName,
      recordJson(hd.lifeRecord), recordJson(hd.cyRecord), recordJson(hd.pyRecord),
      recordJson(hd.trackRecord), recordJson(hd.fstRecord), recordJson(hd.offRecord),
      recordJson(hd.disRecord), recordJson(hd.trfRecord), recordJson(hd.awRecord),
      j(h.jockey), j(h.trainer),
      j(h.pastLines), j(h.workouts), j(h.summary),
      ingestedAt,
      isoDate, trackCode, raceNumber, h.programNumber,
    );
}

function upsertBias(
  isoDate: string,
  trackCode: string,
  raceNumber: number,
  b: TrackBiasSnapshot,
  ingestedAt: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO brisnet_race_bias
         (race_date, track_code, race_number, scope, surface, distance, num_races,
          date_range_start, date_range_end, wire_pct, speed_bias_pct,
          wnr_avg_bl_1c, wnr_avg_bl_2c, iv_e, iv_ep, iv_p, iv_s,
          pct_e, pct_ep, pct_p, pct_s, dominant_style, favorable_styles,
          iv_rail, iv_1_3, iv_4_7, iv_8plus, pct_rail, pct_1_3, pct_4_7, pct_8plus,
          favorable_posts, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (race_date, track_code, race_number, scope)
       DO UPDATE SET
         surface=excluded.surface, distance=excluded.distance, num_races=excluded.num_races,
         date_range_start=excluded.date_range_start, date_range_end=excluded.date_range_end,
         wire_pct=excluded.wire_pct, speed_bias_pct=excluded.speed_bias_pct,
         wnr_avg_bl_1c=excluded.wnr_avg_bl_1c, wnr_avg_bl_2c=excluded.wnr_avg_bl_2c,
         iv_e=excluded.iv_e, iv_ep=excluded.iv_ep, iv_p=excluded.iv_p, iv_s=excluded.iv_s,
         pct_e=excluded.pct_e, pct_ep=excluded.pct_ep, pct_p=excluded.pct_p, pct_s=excluded.pct_s,
         dominant_style=excluded.dominant_style, favorable_styles=excluded.favorable_styles,
         iv_rail=excluded.iv_rail, iv_1_3=excluded.iv_1_3, iv_4_7=excluded.iv_4_7, iv_8plus=excluded.iv_8plus,
         pct_rail=excluded.pct_rail, pct_1_3=excluded.pct_1_3, pct_4_7=excluded.pct_4_7, pct_8plus=excluded.pct_8plus,
         favorable_posts=excluded.favorable_posts, ingested_at=excluded.ingested_at`,
    )
    .run(
      isoDate, trackCode, raceNumber, b.scope, b.surface, b.distance, b.numRaces,
      b.dateRangeStart, b.dateRangeEnd, b.wirePct, b.speedBiasPct,
      b.wnrAvgBl1c, b.wnrAvgBl2c, b.ivE, b.ivEp, b.ivP, b.ivS,
      b.pctE, b.pctEp, b.pctP, b.pctS, b.dominantStyle, j(b.favorableStyles),
      b.ivRail, b.iv1_3, b.iv4_7, b.iv8plus, b.pctRail, b.pct1_3, b.pct4_7, b.pct8plus,
      j(b.favorablePosts), ingestedAt,
    );
}

export interface DeepPersistResult {
  runners: number;
  biasRows: number;
  parsRows: number;
}

// Persist an entire parsed DeepCard. Idempotent across re-runs.
export function persistDeepCard(card: DeepCard): DeepPersistResult {
  const isoDate = card.date;
  const trackCode = card.track.trim().toUpperCase();
  const ingestedAt = new Date().toISOString();
  let runners = 0;
  let biasRows = 0;
  let parsRows = 0;

  const tx = sqlite.transaction(() => {
    for (const race of card.races) {
      // pars
      sqlite
        .prepare(
          `INSERT INTO brisnet_race_pars
             (race_date, track_code, race_number, par_e1, par_e2_late, par_spd,
              surface, distance_furlongs, ingested_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT (race_date, track_code, race_number)
           DO UPDATE SET par_e1=excluded.par_e1, par_e2_late=excluded.par_e2_late,
             par_spd=excluded.par_spd, surface=excluded.surface,
             distance_furlongs=excluded.distance_furlongs, ingested_at=excluded.ingested_at`,
        )
        .run(
          isoDate, trackCode, race.raceNumber,
          race.pars.parE1, race.pars.parE2Late, race.pars.parSpd,
          race.surface, race.distanceFurlongs, ingestedAt,
        );
      parsRows++;

      for (const b of race.bias) {
        upsertBias(isoDate, trackCode, race.raceNumber, b, ingestedAt);
        biasRows++;
      }
      for (const h of race.runners) {
        upsertRunner(isoDate, trackCode, race.raceNumber, h, ingestedAt);
        runners++;
      }
    }
  });
  tx();
  return { runners, biasRows, parsRows };
}

// ── Read path ────────────────────────────────────────────────────────────────
// Reconstruct the deep per-runner records for a card, keyed `${raceNumber}|${pgm}`.
// Returns an empty map when the deep ingest never ran, so the engine degrades.

export interface DeepRunnerRow {
  raceNumber: number;
  programNumber: string;
  horseName: string | null;
  runStyle: string | null;
  primePower: number | null;
  primePowerRank: number | null;
  earlySpeedPoints: number | null;
  pedFast: number | null;
  pedOff: number | null;
  pedDistance: number | null;
  pedTurf: number | null;
  sireAwd: number | null;
  sireMudPct: number | null;
  sireTurfPct: number | null;
  mlOdds: number | null;
  jockey: import("./parsers/brisnet-deep").JockeyBlock | null;
  trainer: import("./parsers/brisnet-deep").TrainerBlock | null;
  pastLines: import("./parsers/brisnet-deep").DeepPastLine[];
  workouts: import("./parsers/brisnet-deep").DeepWorkout[];
  summary: import("./parsers/brisnet-deep").RaceSummaryDerived | null;
}

function parseJson<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function getDeepRunnersForCard(
  isoDate: string,
  trackCode: string,
): Map<string, DeepRunnerRow> {
  const out = new Map<string, DeepRunnerRow>();
  try {
    const rows = sqlite
      .prepare(
        `SELECT race_number, program_number, horse_name, run_style, prime_power,
                prime_power_rank, early_speed_points, ped_fast, ped_off, ped_distance,
                ped_turf, sire_awd, sire_mud_pct, sire_turf_pct, ml_odds_deep,
                jockey_block, trainer_block, past_lines, workouts, race_summary
           FROM brisnet_horse_data
          WHERE race_date = ? AND track_code = ?`,
      )
      .all(isoDate, trackCode.trim().toUpperCase()) as Record<string, unknown>[];
    for (const r of rows) {
      const raceNumber = Number(r.race_number);
      const pgm = String(r.program_number);
      out.set(`${raceNumber}|${pgm}`, {
        raceNumber,
        programNumber: pgm,
        horseName: (r.horse_name as string) ?? null,
        runStyle: (r.run_style as string) ?? null,
        primePower: (r.prime_power as number) ?? null,
        primePowerRank: (r.prime_power_rank as number) ?? null,
        earlySpeedPoints: (r.early_speed_points as number) ?? null,
        pedFast: (r.ped_fast as number) ?? null,
        pedOff: (r.ped_off as number) ?? null,
        pedDistance: (r.ped_distance as number) ?? null,
        pedTurf: (r.ped_turf as number) ?? null,
        sireAwd: (r.sire_awd as number) ?? null,
        sireMudPct: (r.sire_mud_pct as number) ?? null,
        sireTurfPct: (r.sire_turf_pct as number) ?? null,
        mlOdds: (r.ml_odds_deep as number) ?? null,
        jockey: parseJson(r.jockey_block as string | null),
        trainer: parseJson(r.trainer_block as string | null),
        pastLines: parseJson<import("./parsers/brisnet-deep").DeepPastLine[]>(r.past_lines as string | null) ?? [],
        workouts: parseJson<import("./parsers/brisnet-deep").DeepWorkout[]>(r.workouts as string | null) ?? [],
        summary: parseJson(r.race_summary as string | null),
      });
    }
  } catch {
    /* table/columns missing on a fresh install — degrade silently */
  }
  return out;
}

export function getRacePars(
  isoDate: string,
  trackCode: string,
  raceNumber: number,
): DeepRacePars {
  try {
    const r = sqlite
      .prepare(
        `SELECT par_e1, par_e2_late, par_spd FROM brisnet_race_pars
          WHERE race_date = ? AND track_code = ? AND race_number = ?`,
      )
      .get(isoDate, trackCode.trim().toUpperCase(), raceNumber) as
      | Record<string, unknown>
      | undefined;
    return {
      parE1: (r?.par_e1 as number) ?? null,
      parE2Late: (r?.par_e2_late as number) ?? null,
      parSpd: (r?.par_spd as number) ?? null,
    };
  } catch {
    return { parE1: null, parE2Late: null, parSpd: null };
  }
}

// Reconstruct a feature-ready DeepRace from the persisted deep rows for one
// race. The JSON blocks (jockey/trainer/pastLines/workouts/summary) round-trip
// exactly; the header is rebuilt from the flattened scalar columns the read path
// exposes (enough for the features that gate on them — pace/bias/pedigree).
// Returns null when the deep ingest never ran for this race.
export function getDeepRaceForVoice(
  isoDate: string,
  trackCode: string,
  raceNumber: number,
): DeepRace | null {
  const all = getDeepRunnersForCard(isoDate, trackCode);
  const rows = Array.from(all.values()).filter((r) => r.raceNumber === raceNumber);
  if (rows.length === 0) return null;

  const runners: DeepRunner[] = rows.map((row) => ({
    programNumber: row.programNumber,
    horseName: row.horseName,
    sireName: null,
    damName: null,
    damSireName: null,
    mlOdds: row.mlOdds,
    header: {
      primePower: row.primePower,
      primePowerRank: row.primePowerRank,
      runStyle: (row.runStyle as RunStyle | null) ?? null,
      earlySpeedPoints: row.earlySpeedPoints,
      pedFast: row.pedFast,
      pedOff: row.pedOff,
      pedDistance: row.pedDistance,
      pedTurf: row.pedTurf,
      medLasix: null,
      medBute: false,
      blinkers: null,
      weightCarried: null,
      apprenticeAllowance: null,
      denotation: null,
      claimPrice: null,
      dpi: null,
      spi: null,
      sireAwd: row.sireAwd,
      damSireAwd: null,
      sireMudPct: row.sireMudPct,
      sireMudStarts: null,
      sireTurfPct: row.sireTurfPct,
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
    },
    jockey: row.jockey ?? emptyJockeyBlock(),
    trainer: row.trainer ?? { meetStarts: null, meet1: null, meet2: null, meet3: null, meetWinPct: null, yearStarts: null, yearWinPct: null, yearItmPct: null, yearRoi: null, angles3yr: {} },
    pastLines: row.pastLines,
    workouts: row.workouts,
    summary: row.summary ?? emptySummaryBlock(),
  }));

  let surface: string | null = null;
  let distanceFurlongs: number | null = null;
  try {
    const meta = sqlite
      .prepare(
        `SELECT surface, distance_furlongs FROM brisnet_race_pars
          WHERE race_date = ? AND track_code = ? AND race_number = ?`,
      )
      .get(isoDate, trackCode.trim().toUpperCase(), raceNumber) as
      | Record<string, unknown>
      | undefined;
    surface = (meta?.surface as string) ?? null;
    distanceFurlongs = (meta?.distance_furlongs as number) ?? null;
  } catch {
    /* columns missing on a pre-migration install — degrade */
  }

  return {
    raceNumber,
    conditionsRaw: null,
    surface,
    distanceFurlongs,
    pars: getRacePars(isoDate, trackCode, raceNumber),
    bias: getRaceBias(isoDate, trackCode, raceNumber),
    runners,
  };
}

function emptyJockeyBlock(): import("./parsers/brisnet-deep").JockeyBlock {
  return {
    meetMounts: null, meet1: null, meet2: null, meet3: null, meetWinPct: null,
    yearMounts: null, yearWinPct: null, yearItmPct: null, yearRoi: null,
    runStyleMounts: null, runStyleWinPct: null, runStyleItmPct: null, runStyleRoi: null,
    trnL60Mounts: null, trnL60WinPct: null, trnL60ItmPct: null, trnL60Roi: null,
    distSurfMounts: null, distSurfWinPct: null, distSurfItmPct: null, distSurfRoi: null,
  };
}

function emptySummaryBlock(): import("./parsers/brisnet-deep").RaceSummaryDerived {
  return {
    avgDsE1: null, avgDsE2: null, avgDsLate: null, avgDsSpd: null, avgDsSampleFlag: null,
    avgRaceRtng: null, bestPaceE1: null, bestPaceE2: null, bestPaceLp: null,
    finalSpd1: null, finalSpd2: null, finalSpd3: null, finalSpd4: null,
    acl: null, aclDistSurfMatch: false, regSpdAvg: null,
    prevRr1: null, prevRr2: null, prevRr3: null, mudSpd: null,
    daysSinceLr: null, layoffCount: null, speedLastRace: null, backSpeed: null,
    currentClass: null, avgClassLast3: null, earlyPaceLastRace: null, latePaceLastRace: null,
  };
}

export function getRaceBias(
  isoDate: string,
  trackCode: string,
  raceNumber: number,
): TrackBiasSnapshot[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT * FROM brisnet_race_bias
          WHERE race_date = ? AND track_code = ? AND race_number = ?`,
      )
      .all(isoDate, trackCode.trim().toUpperCase(), raceNumber) as Record<string, unknown>[];
    return rows.map((r) => ({
      scope: (r.scope as TrackBiasSnapshot["scope"]) ?? "MEET",
      surface: (r.surface as string) ?? null,
      distance: (r.distance as string) ?? null,
      numRaces: (r.num_races as number) ?? null,
      dateRangeStart: (r.date_range_start as string) ?? null,
      dateRangeEnd: (r.date_range_end as string) ?? null,
      wirePct: (r.wire_pct as number) ?? null,
      speedBiasPct: (r.speed_bias_pct as number) ?? null,
      wnrAvgBl1c: (r.wnr_avg_bl_1c as number) ?? null,
      wnrAvgBl2c: (r.wnr_avg_bl_2c as number) ?? null,
      ivE: (r.iv_e as number) ?? null,
      ivEp: (r.iv_ep as number) ?? null,
      ivP: (r.iv_p as number) ?? null,
      ivS: (r.iv_s as number) ?? null,
      pctE: (r.pct_e as number) ?? null,
      pctEp: (r.pct_ep as number) ?? null,
      pctP: (r.pct_p as number) ?? null,
      pctS: (r.pct_s as number) ?? null,
      dominantStyle: (r.dominant_style as TrackBiasSnapshot["dominantStyle"]) ?? null,
      favorableStyles: parseJson<TrackBiasSnapshot["favorableStyles"]>(r.favorable_styles as string | null) ?? [],
      ivRail: (r.iv_rail as number) ?? null,
      iv1_3: (r.iv_1_3 as number) ?? null,
      iv4_7: (r.iv_4_7 as number) ?? null,
      iv8plus: (r.iv_8plus as number) ?? null,
      pctRail: (r.pct_rail as number) ?? null,
      pct1_3: (r.pct_1_3 as number) ?? null,
      pct4_7: (r.pct_4_7 as number) ?? null,
      pct8plus: (r.pct_8plus as number) ?? null,
      favorablePosts: parseJson<string[]>(r.favorable_posts as string | null) ?? [],
    }));
  } catch {
    return [];
  }
}
