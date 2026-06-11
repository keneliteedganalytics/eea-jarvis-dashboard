// One-shot repair for the Thistledown card (id=19), whose races.flags column was
// written as legacy plain text ("BULLET on #7 | BULLET on #6") instead of a JSON
// string-array, crashing the client's JSON.parse. Reads each race's CURRENT
// flags, parses the legacy " | " / "," separated text into a real array, and
// writes it back as proper JSON via PATCH /api/races/:id/flags.
//
// The client is now tolerant (client/src/lib/parseFlags.ts) so the crash is
// already fixed; this normalizes the stored data so the value is clean JSON.
//
// Run AFTER the fix deploys:
//   npx tsx scripts/repair-thistledown-flags.ts
//   # overrides: JARVIS_BASE_URL=... JARVIS_USER=... JARVIS_PASS=... ADMIN_PIN=...

const BASE_URL = process.env.JARVIS_BASE_URL || "https://jarvis.elite-edge-analytics.com";
const USER = process.env.JARVIS_USER || "EliteEdgeAnalytics";
const PASS = process.env.JARVIS_PASS || "Austin08";
const ADMIN_PIN = process.env.ADMIN_PIN || "5811";
const CARD_ID = 19;

const basicAuth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

// Same tolerant parse the client uses, so the repaired data matches the render.
function parseFlags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // legacy/plain text: split on common separators
  }
  return raw.split(/\s*[|,]\s*/).filter(Boolean);
}

interface RaceLite {
  id: number;
  raceNumber: number;
  flags: unknown;
}
interface CardLite {
  id: number;
  track: string;
  races: RaceLite[];
}

async function main(): Promise<void> {
  console.log(`[repair-flags] fetching card ${CARD_ID} from ${BASE_URL}…`);
  const cardRes = await fetch(`${BASE_URL}/api/cards/${CARD_ID}`, {
    headers: { Authorization: basicAuth },
  });
  if (!cardRes.ok) {
    throw new Error(`GET /api/cards/${CARD_ID} failed: ${cardRes.status} ${await cardRes.text()}`);
  }
  const card = (await cardRes.json()) as CardLite;
  console.log(`[repair-flags] ${card.track} — ${card.races.length} races`);

  let patched = 0;
  let skipped = 0;
  for (const race of card.races) {
    const flags = parseFlags(race.flags);
    // Already-clean JSON arrays round-trip to the same string — skip those.
    const current = typeof race.flags === "string" ? race.flags : JSON.stringify(race.flags ?? []);
    const next = JSON.stringify(flags);
    if (current === next) {
      skipped++;
      console.log(`[repair-flags] R${race.raceNumber} (id=${race.id}) already clean: ${next}`);
      continue;
    }

    const res = await fetch(`${BASE_URL}/api/races/${race.id}/flags`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: basicAuth,
        "x-admin-pin": ADMIN_PIN,
      },
      body: JSON.stringify({ flags }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`[repair-flags] R${race.raceNumber} (id=${race.id}) FAILED: ${res.status} ${bodyText}`);
      continue;
    }
    patched++;
    console.log(`[repair-flags] R${race.raceNumber} (id=${race.id}) ${JSON.stringify(race.flags)} -> ${next}`);
  }

  console.log(`[repair-flags] done — ${patched} patched, ${skipped} already clean.`);
}

main().catch((err) => {
  console.error("[repair-flags] FAILED:", err);
  process.exit(1);
});
