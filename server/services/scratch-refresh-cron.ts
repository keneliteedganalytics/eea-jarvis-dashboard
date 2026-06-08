// Scratch-refresh scheduler (PR #20).
//
// Every 15 minutes during the racing day, re-diff each locked card's roster
// against its source and apply scratches/reinstatements (see scratch-refresh.ts).
// The repo has no node-cron dependency, so this is a self-rescheduling
// setInterval in the same style as weather-cron.ts / poller.ts.
//
// "During the racing day" = between 10:00am track-local and (last race post +
// 1h) track-local, evaluated per card in the track's own time zone (post times
// are stored as UTC, track tz comes from PR #18's track_locations.json). A card
// is only swept while it still has a future post time, so the window naturally
// closes after the last race goes off.

import { sqlite } from "../db";
import { storage } from "../storage";
import { resolveTrackLocation } from "./weather";
import { refreshScratchesForCard, isScratchRefreshError } from "./scratch-refresh";

const REFRESH_MS = 15 * 60 * 1000;
const WINDOW_OPEN_LOCAL_HOUR = 10; // 10am track-local
const WINDOW_TAIL_MS = 60 * 60 * 1000; // last race post + 1h
let timer: NodeJS.Timeout | null = null;

interface CardRosterRow {
  card_id: number;
  track: string;
  posts: string[]; // ISO 8601 UTC post times for the card's races
}

// How many whole hours a zone is behind UTC on `when` (e.g. America/New_York in
// June = 4). Uses Intl so DST is handled automatically. Same trick as
// show-cron's boiseSevenAmUtcHour, generalized to any IANA zone.
function zoneBehindUtcHours(tz: string, when: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const localHour = Number(fmt.format(when));
  const utcHour = when.getUTCHours();
  return (utcHour - localHour + 24) % 24;
}

// Is `now` inside the racing window for a card whose races post at `posts`
// (UTC ISO instants) at a track in zone `tz`? Window = [10am local,
// lastPost + 1h]. Returns false when there are no parseable post times.
//
// Exported + pure for unit testing.
export function inRacingWindow(
  posts: string[],
  tz: string,
  now: Date = new Date(),
): boolean {
  const postMs = posts
    .map((p) => Date.parse(p))
    .filter((ms) => Number.isFinite(ms));
  if (postMs.length === 0) return false;

  const lastPost = Math.max(...postMs);
  if (now.getTime() > lastPost + WINDOW_TAIL_MS) return false;

  // 10am track-local on the calendar day of `now`, expressed as a UTC instant:
  // local 10:00 == UTC (10 + behind):00 on the same local date. Derive the local
  // Y-M-D via Intl so we anchor to the track's day, not the server's.
  const behind = zoneBehindUtcHours(tz, now);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD"
  const openUtcMs = Date.parse(`${parts}T00:00:00Z`) +
    (WINDOW_OPEN_LOCAL_HOUR + behind) * 60 * 60 * 1000;

  return now.getTime() >= openUtcMs;
}

// Locked cards dated today (track-agnostic: today's UTC day) that still carry at
// least one future post time, with all their post times for window evaluation.
export function scratchTargets(now: Date = new Date()): CardRosterRow[] {
  const today = now.toISOString().slice(0, 10);
  const rows = sqlite
    .prepare(
      `SELECT c.id AS card_id, c.track AS track, r.post_time_utc AS post_time_utc
         FROM cards c
         JOIN races r ON r.card_id = c.id
        WHERE c.locked = 1
          AND c.date = ?
          AND r.post_time_utc IS NOT NULL
          AND r.post_time_utc != ''`,
    )
    .all(today) as { card_id: number; track: string; post_time_utc: string }[];

  const byCard = new Map<number, CardRosterRow>();
  for (const row of rows) {
    const cur = byCard.get(row.card_id) ?? { card_id: row.card_id, track: row.track, posts: [] };
    cur.posts.push(row.post_time_utc);
    byCard.set(row.card_id, cur);
  }

  const nowMs = now.getTime();
  return Array.from(byCard.values()).filter((c) =>
    c.posts.some((p) => {
      const ms = Date.parse(p);
      return Number.isFinite(ms) && ms > nowMs;
    }),
  );
}

// Run one sweep: for every in-window locked card with a future post, refresh
// scratches and log the summary at INFO. Never throws.
export function refreshScratchesNow(now: Date = new Date()): { swept: number } {
  let swept = 0;
  for (const card of scratchTargets(now)) {
    const loc = resolveTrackLocation(card.track);
    const tz = loc?.tz ?? "America/New_York";
    if (!inRacingWindow(card.posts, tz, now)) continue;

    try {
      const result = refreshScratchesForCard(card.card_id);
      if (isScratchRefreshError(result)) {
        console.log(
          `[scratch-cron] card ${card.card_id} (${card.track}) skipped: ${result.reason}`,
        );
      } else {
        console.log(
          `[scratch-cron] card ${card.card_id} (${card.track}): ` +
            `${result.racesChecked} races, ${result.newScratches.length} scratched, ` +
            `${result.reinstated.length} reinstated`,
        );
      }
      swept++;
    } catch (e) {
      console.error(`[scratch-cron] card ${card.card_id} failed:`, e);
    }
  }
  return { swept };
}

function scheduleSweep(): void {
  try {
    refreshScratchesNow();
  } catch (e) {
    console.error("[scratch-cron] sweep error:", e);
  }
}

export function startScratchRefreshCron(): void {
  if (timer) return;
  // Run shortly after boot, then every 15 minutes.
  setTimeout(scheduleSweep, 25 * 1000).unref?.();
  timer = setInterval(scheduleSweep, REFRESH_MS);
  timer.unref?.();
  console.log("[scratch-cron] scheduled — every 15 min during racing hours");
}
