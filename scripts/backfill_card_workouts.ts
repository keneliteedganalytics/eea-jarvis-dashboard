// Backfill horse-level workout annotations onto an existing card's races via
// PATCH /api/races/:id (workout annotations feature, see
// handicapping/workouts_feature_spec.md).
//
// Reads a JSON file mapping each race number to the per-program workout tags
// (and optionally the raw workout line), then PATCHes each race on the card.
// The server sanitizes the tags (filtering to {BULLET,GATE,SHARP,NO_WORK} and
// silently dropping anything else), so this script just forwards the payload.
//
// Input file shape — annotations only:
//   { "1": { "3": ["BULLET"], "6": ["GATE", "SHARP"] },
//     "2": { "4": ["NO_WORK"] } }
//
// Input file shape — annotations + raw workout text (optional):
//   { "1": {
//       "annotations": { "3": ["BULLET"] },
//       "workoutText":  { "3": "4f 47.2 H (bullet, 1/22)" }
//   } }
//
// Both shapes may be mixed across races. A bare race entry is treated as the
// annotations map (first shape).
//
// Usage:
//   npx tsx scripts/backfill_card_workouts.ts <cardId> <path-to-json>
//   # overrides: JARVIS_BASE_URL=... JARVIS_USER=... JARVIS_PASS=... ADMIN_PIN=...
//
// NOT run automatically — invoke by hand once the feature has deployed.

import { readFileSync } from "node:fs";

const BASE_URL = process.env.JARVIS_BASE_URL || "https://jarvis.elite-edge-analytics.com";
const USER = process.env.JARVIS_USER || "EliteEdgeAnalytics";
const PASS = process.env.JARVIS_PASS || "Austin08";
const ADMIN_PIN = process.env.ADMIN_PIN || "5811";

const basicAuth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

interface RaceLite {
  id: number;
  raceNumber: number;
}
interface CardLite {
  id: number;
  track: string;
  races: RaceLite[];
}

type Tags = Record<string, string[]>;
type RaceEntry = Tags | { annotations?: Tags; workoutText?: Record<string, string> };

function splitEntry(entry: RaceEntry): {
  annotations: Tags | null;
  workoutText: Record<string, string> | null;
} {
  if (entry && typeof entry === "object" && ("annotations" in entry || "workoutText" in entry)) {
    const e = entry as { annotations?: Tags; workoutText?: Record<string, string> };
    return { annotations: e.annotations ?? null, workoutText: e.workoutText ?? null };
  }
  return { annotations: (entry as Tags) ?? null, workoutText: null };
}

async function main(): Promise<void> {
  const cardId = Number(process.argv[2]);
  const jsonPath = process.argv[3];
  if (!Number.isFinite(cardId) || !jsonPath) {
    console.error("Usage: tsx scripts/backfill_card_workouts.ts <cardId> <path-to-json>");
    process.exit(1);
  }

  const byRace = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, RaceEntry>;

  console.log(`[backfill-workouts] fetching card ${cardId} from ${BASE_URL}…`);
  const cardRes = await fetch(`${BASE_URL}/api/cards/${cardId}`, {
    headers: { Authorization: basicAuth },
  });
  if (!cardRes.ok) {
    throw new Error(`GET /api/cards/${cardId} failed: ${cardRes.status} ${await cardRes.text()}`);
  }
  const card = (await cardRes.json()) as CardLite;
  console.log(`[backfill-workouts] ${card.track} — ${card.races.length} races`);

  let patched = 0;
  let skipped = 0;
  for (const race of card.races) {
    const entry = byRace[String(race.raceNumber)];
    if (!entry) {
      skipped++;
      continue;
    }
    const { annotations, workoutText } = splitEntry(entry);
    const body: Record<string, unknown> = {};
    if (annotations) body.horseAnnotations = annotations;
    if (workoutText) body.horseWorkoutText = workoutText;
    if (Object.keys(body).length === 0) {
      skipped++;
      continue;
    }

    const res = await fetch(`${BASE_URL}/api/races/${race.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: basicAuth,
        "x-admin-pin": ADMIN_PIN,
      },
      body: JSON.stringify(body),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error(
        `[backfill-workouts] R${race.raceNumber} (id=${race.id}) FAILED: ${res.status} ${bodyText}`,
      );
      continue;
    }
    patched++;
    console.log(
      `[backfill-workouts] R${race.raceNumber} (id=${race.id}) <- ${JSON.stringify(body)}`,
    );
  }

  console.log(`[backfill-workouts] done — ${patched} patched, ${skipped} skipped.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
