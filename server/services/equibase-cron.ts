// Daily Equibase PP auto-ingest scheduler.
//
// Fires once per day at 06:00 America/Boise — one hour before the 7am show
// build — and ingests *tomorrow's* PPs for the enabled tracks. The repo has no
// node-cron dependency, so this is a self-rescheduling setTimeout (same style
// as the poller) rather than a cron string. DST is handled by reusing
// boiseSevenAmUtcHour() and subtracting an hour.

import { boiseSevenAmUtcHour } from "./show-cron";
import { ingestForDate, tomorrowInBoise } from "./equibase-ingest";

let timer: NodeJS.Timeout | null = null;

// The UTC hour that is 06:00 America/Boise (= 7am hour − 1, wrapped).
export function boiseSixAmUtcHour(when: Date = new Date()): number {
  return (boiseSevenAmUtcHour(when) + 23) % 24;
}

// Milliseconds from `now` until the next 06:00-Boise instant (minute 6 to avoid
// the top-of-hour stampede). Always strictly in the future.
export function msUntilNextSixAmBoise(now: Date = new Date()): number {
  const targetHour = boiseSixAmUtcHour(now);
  const next = new Date(now);
  next.setUTCHours(targetHour, 6, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleNext(): void {
  const delay = msUntilNextSixAmBoise();
  timer = setTimeout(async () => {
    try {
      const target = tomorrowInBoise();
      console.log(
        `[equibase-cron] 6am ingest firing for ${target.toDateString()}`,
      );
      const result = await ingestForDate(target, undefined, "cron");
      console.log(
        `[equibase-cron] done: status=${result.status} tracks=${result.results.length}`,
      );
    } catch (e) {
      console.error("[equibase-cron] ingest threw:", e);
    } finally {
      scheduleNext();
    }
  }, delay);
  timer.unref?.();
}

export function startEquibaseIngestCron(): void {
  if (process.env.NODE_ENV !== "production") {
    console.log("[equibase-cron] disabled (NODE_ENV != production)");
    return;
  }
  if (timer) return;
  scheduleNext();
  console.log("[equibase-cron] scheduled — daily 6am America/Boise");
}
