// Daily Show cron support. Two pure helpers (testable without I/O):
//   - cardNeedsShow(card, show): decides whether a card needs a (re)build
//   - boiseSevenAmUtcHour(date): the UTC hour that is 7am America/Boise,
//     computed dynamically so it stays correct across MDT (UTC-6) / MST (UTC-7).
// The build/active driver lives in the show routes; this module is the policy.

import type { Card, CardShow, ShowManifest } from "@shared/schema";

// A card needs a show built when there's no show row, the prior build errored,
// or the card was modified after the manifest was generated (stale). A row in
// `building`/`ready` with a fresh manifest is skipped.
export function cardNeedsShow(card: Card, show: CardShow | undefined): boolean {
  if (!show) return true;
  if (show.status === "error") return true;
  if (show.status === "queued") return true;
  if (show.status === "requested") return false; // Computer should pick this up next
  if (show.status === "building") return false; // a build is already in flight
  if (show.status === "ready") {
    if (!show.manifestJson) return true;
    let manifest: ShowManifest;
    try {
      manifest = JSON.parse(show.manifestJson) as ShowManifest;
    } catch {
      return true; // corrupt manifest — rebuild
    }
    // Cards carry createdAt (no updatedAt column); treat it as last-modified.
    const cardTs = Date.parse(card.createdAt);
    const manifestTs = Date.parse(manifest.generatedAt);
    if (Number.isFinite(cardTs) && Number.isFinite(manifestTs) && cardTs > manifestTs) {
      return true; // card changed after the show was generated
    }
    return false;
  }
  return true;
}

// Compute the UTC hour corresponding to 7:00am America/Boise for a given date,
// using Intl so DST is handled automatically (summer MDT = UTC-6 → 13:00 UTC;
// winter MST = UTC-7 → 14:00 UTC). Returns 0-23.
export function boiseSevenAmUtcHour(when: Date = new Date()): number {
  // Find Boise's UTC offset (in hours) on `when` by comparing the wall-clock
  // hour Boise reports against the UTC hour for the same instant.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Boise",
    hour: "numeric",
    hour12: false,
  });
  const boiseHour = Number(fmt.format(when));
  const utcHour = when.getUTCHours();
  // How far Boise is behind UTC, in whole hours (6 in summer, 7 in winter).
  const behind = (utcHour - boiseHour + 24) % 24;
  // 7am local + behind hours = the UTC hour.
  return (7 + behind) % 24;
}

// Build the cron expression string for 7am America/Boise (minute 7 to avoid the
// top-of-hour stampede). Computed dynamically so a deploy in winter vs summer
// registers the right UTC hour.
export function boiseSevenAmCron(when: Date = new Date()): string {
  return `7 ${boiseSevenAmUtcHour(when)} * * *`;
}
