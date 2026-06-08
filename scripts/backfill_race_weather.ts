// One-shot backfill for race_weather (PR #18).
//
// Fills a race_weather row for every race whose post_time_utc is within the next
// 48 hours and that has no weather row yet. Races already carrying weather are
// skipped, so this is safe to re-run. Fetches never throw — a race that can't be
// resolved (unknown track, API down) is written as a "unknown" row so it isn't
// retried endlessly by this script (the 30-min cron will refresh it later).
//
// Usage:  tsx scripts/backfill_race_weather.ts [--dry-run]

import { sqlite } from "../server/db";
import { storage } from "../server/storage";
import { getRaceWeather } from "../server/services/weather";

const DRY_RUN = process.argv.includes("--dry-run");
const HORIZON_MS = 48 * 60 * 60 * 1000;

interface Row {
  race_id: number;
  track: string;
  post_time_utc: string;
}

function pendingRaces(now: Date): Row[] {
  const rows = sqlite
    .prepare(
      `SELECT r.id AS race_id, c.track AS track, r.post_time_utc AS post_time_utc
         FROM races r
         JOIN cards c ON c.id = r.card_id
        WHERE r.post_time_utc IS NOT NULL
          AND r.post_time_utc != ''
          AND NOT EXISTS (SELECT 1 FROM race_weather w WHERE w.race_id = r.id)`,
    )
    .all() as Row[];
  // Keep only races within the next 48h (future-facing; the One Call forecast
  // doesn't cover the past).
  return rows.filter((r) => {
    const t = new Date(r.post_time_utc).getTime();
    if (Number.isNaN(t)) return false;
    const delta = t - now.getTime();
    return delta >= -60 * 60 * 1000 && delta <= HORIZON_MS;
  });
}

async function main(): Promise<void> {
  const now = new Date();
  const pending = pendingRaces(now);
  console.log(
    `[backfill-weather] ${pending.length} race(s) in the next 48h need weather.`,
  );
  if (pending.length === 0) {
    console.log("[backfill-weather] nothing to do.");
    console.log("[backfill-weather] rows written: 0");
    return;
  }

  let written = 0;
  for (const r of pending) {
    const w = await getRaceWeather(r.track, r.post_time_utc);
    console.log(
      `[backfill-weather] race ${r.race_id} (${r.track} @ ${r.post_time_utc}) -> ${w.surfaceImpact}` +
        (w.tempF != null ? ` ${w.tempF}°F ${w.conditions}` : ""),
    );
    if (!DRY_RUN) {
      storage.upsertRaceWeather(r.race_id, w);
      written++;
    }
  }
  console.log(
    `[backfill-weather] rows written: ${DRY_RUN ? 0 : written}${DRY_RUN ? " (dry-run)" : ""}`,
  );
}

main().catch((e) => {
  console.error("[backfill-weather] fatal:", e);
  process.exit(1);
});
