// Brisnet DRM daily auto-ingest, chained to run right AFTER the Equibase ingest
// in the same 6am America/Boise slot (sequential, never parallel — Brisnet and
// Equibase hit different sites but we keep them ordered so logs/telemetry read
// cleanly and the two runs don't compete for the same network/CPU window).
//
// There is no standalone timer here: equibase-cron invokes runBrisnetIngestNow()
// in its firing callback once the Equibase ingest resolves. This module owns the
// "what to ingest" logic so it stays testable and reusable from the admin route.

import { ingestForDate, tomorrowInBoise } from "./brisnet-ingest";

// Run tomorrow's DRM ingest for the enabled tracks. Never throws — errors are
// captured into the IngestResult + telemetry by ingestForDate itself.
export async function runBrisnetIngestNow(): Promise<void> {
  try {
    const target = tomorrowInBoise();
    console.log(
      `[brisnet-cron] ingest firing for ${target.toDateString()} (after Equibase)`,
    );
    const result = await ingestForDate(target, undefined, "cron");
    console.log(
      `[brisnet-cron] done: status=${result.status} tracks=${result.results.length}`,
    );
  } catch (e) {
    console.error("[brisnet-cron] ingest threw:", e);
  }
}
