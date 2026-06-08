// Weather refresh scheduler (PR #18).
//
// Every 30 minutes, re-fetch the forecast for every race on today's and
// tomorrow's cards that carries a post_time_utc, and upsert race_weather. The
// repo has no node-cron dependency, so this is a self-rescheduling setInterval
// (same style as poller.ts). The in-memory cache in weather.ts dedupes races
// that share an hour bucket, so a full sweep is cheap.

import { sqlite } from "../db";
import { storage } from "../storage";
import { getRaceWeather } from "./weather";

const REFRESH_MS = 30 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

interface WeatherTargetRow {
  race_id: number;
  track: string;
  post_time_utc: string;
}

// Today + tomorrow in UTC calendar terms — the card.date is a YYYY-MM-DD string.
function todayAndTomorrowYmd(now: Date = new Date()): string[] {
  const d0 = now.toISOString().slice(0, 10);
  const t = new Date(now);
  t.setUTCDate(t.getUTCDate() + 1);
  const d1 = t.toISOString().slice(0, 10);
  return [d0, d1];
}

// Every race on today/tomorrow cards that has a post time. Joined to its card's
// track name (the key getRaceWeather resolves against track_locations.json).
export function weatherTargets(now: Date = new Date()): WeatherTargetRow[] {
  const [d0, d1] = todayAndTomorrowYmd(now);
  return sqlite
    .prepare(
      `SELECT r.id AS race_id, c.track AS track, r.post_time_utc AS post_time_utc
         FROM races r
         JOIN cards c ON c.id = r.card_id
        WHERE c.date IN (?, ?)
          AND r.post_time_utc IS NOT NULL
          AND r.post_time_utc != ''`,
    )
    .all(d0, d1) as WeatherTargetRow[];
}

// Refresh weather for today + tomorrow. Returns how many rows were upserted.
// Never throws — individual fetches already degrade to "unknown".
export async function refreshWeatherNow(now: Date = new Date()): Promise<{ updated: number }> {
  const targets = weatherTargets(now);
  let updated = 0;
  for (const t of targets) {
    try {
      const w = await getRaceWeather(t.track, t.post_time_utc);
      storage.upsertRaceWeather(t.race_id, w);
      updated++;
    } catch (e) {
      console.error(`[weather-cron] race ${t.race_id} failed:`, e);
    }
  }
  return { updated };
}

function scheduleSweep(): void {
  refreshWeatherNow()
    .then(({ updated }) => console.log(`[weather-cron] refreshed ${updated} race(s)`))
    .catch((e) => console.error("[weather-cron] sweep error:", e));
}

export function startWeatherCron(): void {
  if (timer) return;
  // Run shortly after boot, then every 30 minutes.
  setTimeout(scheduleSweep, 20 * 1000).unref?.();
  timer = setInterval(scheduleSweep, REFRESH_MS);
  timer.unref?.();
  console.log("[weather-cron] scheduled — every 30 min for today + tomorrow");
}
