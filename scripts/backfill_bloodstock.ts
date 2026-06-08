// One-shot backfill for predictions.bloodstock_json (PR #16 Phase 2).
//
// Re-derives the bloodstock fitness signal for every horse on every existing
// race card using the current scoring logic, and writes it onto each prediction
// row. Idempotent: it recomputes deterministically from the stored card
// conditions + the DRM pedigree names and overwrites bloodstock_json, so re-runs
// converge on the same value. Predictions for horses with no recognizable
// pedigree get a confidence:"none" / applied:false adjustment (never a bias),
// matching the engine's "never bias on missing data" rule.
//
// The rating delta written here mirrors eea-fusion's NORMAL-mode formula
// (centered = (composite-50)/50, delta = centered * maxBiasPoints, with the wet
// boost/penalty interaction). First-timer hard-lean mode is rating-relative and
// is left to live fusion; the backfill records the signal + a capped normal
// delta so the chip and any post-hoc analysis have a value.
//
// Usage:  tsx scripts/backfill_bloodstock.ts [--dry-run]

import { sqlite } from "../server/db";
import { computeBloodstockFitness } from "../server/bloodstock";
import { DEFAULT_WEIGHTS } from "../server/services/eea-config";
import type { RaceConditions } from "../server/services/parsers/types";

const DRY_RUN = process.argv.includes("--dry-run");
const BW = DEFAULT_WEIGHTS.bloodstock;
const OFF_TRACK = new Set(["wet", "sloppy", "muddy"]);

interface Row {
  prediction_id: number;
  horse_pgm: string;
  race_number: number;
  conditions: string | null;
  surface_impact: string | null;
  race_date: string;
  track: string;
}

function predictionRows(): Row[] {
  return sqlite
    .prepare(
      `SELECT p.id           AS prediction_id,
              p.horse_pgm     AS horse_pgm,
              r.race_number   AS race_number,
              r.conditions    AS conditions,
              w.surface_impact AS surface_impact,
              c.date          AS race_date,
              c.track         AS track
         FROM predictions p
         JOIN races r ON r.id = p.race_id
         JOIN cards c ON c.id = r.card_id
         LEFT JOIN race_weather w ON w.race_id = r.id`,
    )
    .all() as Row[];
}

interface DrmRow {
  sire_name: string | null;
  dam_name: string | null;
  dam_sire_name: string | null;
}

function drmFor(date: string, track: string, raceNumber: number, pgm: string): DrmRow | undefined {
  return sqlite
    .prepare(
      `SELECT sire_name, dam_name, dam_sire_name
         FROM brisnet_horse_data
        WHERE race_date = ? AND track_code = ? AND race_number = ? AND program_number = ?`,
    )
    .get(date, track.trim().toUpperCase(), raceNumber, pgm) as DrmRow | undefined;
}

// Parse the stored conditions text back into the minimal RaceConditions the
// scorer needs (surface + distance). The conditions cell holds the cleaned
// human string; we sniff surface + a distance token out of it.
function conditionsFrom(raw: string | null): RaceConditions {
  const text = raw ?? "";
  const upper = text.toUpperCase();
  const surface = upper.includes("TURF") ? "TURF" : "DIRT";
  const distMatch = text.match(/\d+\s*\d?\/?\d?\s*(?:F|M|MILE|YARDS?)/i);
  return { type: "UNKNOWN", raw: text, surface, distance: distMatch?.[0] };
}

function main(): void {
  const rows = predictionRows();
  console.log(`[backfill-bloodstock] ${rows.length} prediction row(s) to re-derive.`);

  let written = 0;
  let applied = 0;
  const update = sqlite.prepare(`UPDATE predictions SET bloodstock_json = ? WHERE id = ?`);

  const tx = sqlite.transaction(() => {
    for (const r of rows) {
      const drm = drmFor(r.race_date, r.track, r.race_number, r.horse_pgm);
      const conditions = conditionsFrom(r.conditions);
      const surfaceWet = OFF_TRACK.has((r.surface_impact ?? "").toLowerCase());

      const fitness = computeBloodstockFitness(
        {
          sireName: drm?.sire_name ?? null,
          damName: drm?.dam_name ?? null,
          damSireName: drm?.dam_sire_name ?? null,
          lifetimeStarts: null,
        },
        { conditions, surfaceWet },
        BW,
      );

      const isApplied = fitness.confidence !== "none";
      let ratingDelta = 0;
      if (isApplied) {
        const centered = (fitness.composite - 50) / 50;
        ratingDelta = centered * BW.maxBiasPoints;
        if (surfaceWet) {
          if (fitness.wetFit >= BW.wetStrongComposite && ratingDelta > 0) {
            ratingDelta *= BW.wetBoostMultiplier;
          } else if (fitness.wetFit <= BW.wetWeakComposite) {
            ratingDelta -= BW.wetPenaltyMax;
          }
        }
        const cap = BW.maxBiasPoints * BW.wetBoostMultiplier;
        ratingDelta = Math.max(-cap, Math.min(cap, ratingDelta));
        applied++;
      }

      const adjustment = {
        applied: isApplied,
        composite: fitness.composite,
        reasonCodes: fitness.reasonCodes,
        confidence: fitness.confidence,
        ratingDelta: Math.round(ratingDelta * 10) / 10,
      };

      if (!DRY_RUN) update.run(JSON.stringify(adjustment), r.prediction_id);
      written++;
    }
  });
  tx();

  console.log(
    `[backfill-bloodstock] rows ${DRY_RUN ? "would be " : ""}written: ${DRY_RUN ? rows.length : written}` +
      ` (${applied} with an applied pedigree signal)${DRY_RUN ? " (dry-run)" : ""}`,
  );
}

main();
