// Manual smoke test for the Playwright-based Brisnet ingest (PR #29).
//
// This hits the REAL Brisnet login + download with real credentials. Do NOT run
// it from CI — repeated logins from a data-center IP raise Akamai's bot score.
// Run it locally or on Railway (whose outbound IP may be allowlisted), e.g.:
//
//   BRISNET_USERNAME=... BRISNET_PASSWORD=... npm run smoke:ingest-brisnet
//   # optional: TRACK=FL DATE=2026-06-09 npm run smoke:ingest-brisnet
//
// It forces a fresh session (bypassing the 6h cache), then runs the normal
// ingest for one track/date and prints the per-track result + a session
// fingerprint (cookie names only — never values).

import "dotenv/config";
import { getOrAcquire } from "../server/services/session-cache";
import { ingestForDate } from "../server/services/brisnet-ingest";

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

async function main(): Promise<void> {
  const track = (process.env.TRACK || "FL").toUpperCase();
  const date = parseDate(process.env.DATE);
  const debug = process.env.SMOKE_DEBUG === "1";

  console.log(`[smoke:brisnet] forcing a fresh session (track=${track})…`);
  const session = await getOrAcquire("brisnet", { force: true, debug, headless: true });
  console.log("[smoke:brisnet] session acquired:", {
    cookieNames: session.cookies.map((c) => c.name),
    userAgent: session.userAgent,
    expiresAt: session.expiresAt?.toISOString() ?? "(session cookies only)",
  });

  console.log(`[smoke:brisnet] ingesting ${track} for ${date.toDateString()}…`);
  const result = await ingestForDate(date, [track], "manual");
  console.log("[smoke:brisnet] result:", JSON.stringify(result, null, 2));

  const ok = result.results.some((r) => r.status === "ok");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke:brisnet] FAILED:", err);
  process.exit(1);
});
