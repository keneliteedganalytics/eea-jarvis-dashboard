// Manual smoke test for the Playwright-based Equibase ingest (PR #29).
//
// Hits the REAL Equibase login + Full-PP download with real credentials. Do NOT
// run from CI — Incapsula scores repeated data-center logins. Run locally or on
// Railway:
//
//   EQUIBASE_USERNAME=... EQUIBASE_PASSWORD=... npm run smoke:ingest-equibase
//   # optional: TRACK=FL DATE=2026-06-09 npm run smoke:ingest-equibase
//
// Forces a fresh session, then runs the normal ingest for one track/date and
// prints the per-track result + a session fingerprint (cookie names only).

import "dotenv/config";
import { getOrAcquire } from "../server/services/session-cache";
import { ingestForDate } from "../server/services/equibase-ingest";

function parseDate(s: string | undefined): Date {
  if (!s) return new Date();
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

async function main(): Promise<void> {
  const track = (process.env.TRACK || "FL").toUpperCase();
  const date = parseDate(process.env.DATE);
  const debug = process.env.SMOKE_DEBUG === "1";

  console.log(`[smoke:equibase] forcing a fresh session (track=${track})…`);
  const session = await getOrAcquire("equibase", { force: true, debug, headless: true });
  console.log("[smoke:equibase] session acquired:", {
    cookieNames: session.cookies.map((c) => c.name),
    userAgent: session.userAgent,
    expiresAt: session.expiresAt?.toISOString() ?? "(session cookies only)",
  });

  console.log(`[smoke:equibase] ingesting ${track} for ${date.toDateString()}…`);
  const result = await ingestForDate(date, [track], "manual");
  console.log("[smoke:equibase] result:", JSON.stringify(result, null, 2));

  const ok = result.results.some((r) => r.status === "ok");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke:equibase] FAILED:", err);
  process.exit(1);
});
