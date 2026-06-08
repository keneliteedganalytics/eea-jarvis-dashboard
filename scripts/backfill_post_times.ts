// One-shot backfill for races with a missing post time (PR #17).
//
// Finds every race where `post` IS NULL/empty OR `post_time_utc` IS NULL, then
// fills both columns using the same resolution the live ingest path now uses:
//   1. Re-parse the card's stored Equibase pp_uploads blob for "Post Time:".
//   2. Re-parse the stored Brisnet blob for its local post token.
//   3. Fall back to previous-race + delta (logged) so we never re-write NULL.
//
// Safe to re-run: races that already have both columns populated are skipped, so
// a card ingested with correct post times is never modified (regression-safe).
//
// Usage:  tsx scripts/backfill_post_times.ts [--dry-run]

import { sqlite } from "../server/db";
import {
  extractEquibasePostTime,
  extractBrisnetDrfPostTime,
  fallbackPostTime,
  type PostTime,
} from "../server/services/parsers/post-time";
import type { EquibaseCard } from "../server/services/parsers/types";

interface RaceRow {
  id: number;
  card_id: number;
  race_number: number;
  post: string | null;
  post_time_utc: string | null;
}

interface CardRow {
  id: number;
  track: string;
  date: string;
}

const DRY_RUN = process.argv.includes("--dry-run");

function needsBackfill(r: RaceRow): boolean {
  return !r.post || r.post.trim() === "" || !r.post_time_utc;
}

// Pull the parsed JSON blobs stored on a card at ingest time, keyed by source.
function uploadsForCard(cardId: number): { equibase?: any; brisnet?: any } {
  const rows = sqlite
    .prepare(
      "SELECT source, parsed_json FROM pp_uploads WHERE card_id = ? AND parsed_json IS NOT NULL",
    )
    .all(cardId) as { source: string; parsed_json: string }[];
  const out: { equibase?: any; brisnet?: any } = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.parsed_json);
      if (row.source === "equibase") out.equibase = parsed;
      else if (row.source === "brisnet") out.brisnet = parsed;
    } catch {
      /* skip unparseable blob */
    }
  }
  return out;
}

function resolveForCard(card: CardRow): Map<number, PostTime> {
  const uploads = uploadsForCard(card.id);
  const equi: EquibaseCard | undefined = uploads.equibase;
  const equiByNum = new Map<number, any>();
  for (const r of equi?.races ?? []) equiByNum.set(r.raceNumber, r);
  const brisByNum = new Map<number, any>();
  for (const r of uploads.brisnet?.races ?? []) brisByNum.set(r.raceNumber, r);

  const raceNums = sqlite
    .prepare("SELECT race_number FROM races WHERE card_id = ? ORDER BY race_number")
    .all(card.id) as { race_number: number }[];

  const out = new Map<number, PostTime>();
  let prev: PostTime | null = null;
  for (const { race_number: n } of raceNums) {
    const eq = equiByNum.get(n);
    const br = brisByNum.get(n);
    let pt: PostTime | null = null;
    if (eq?.postTimeRaw) {
      pt = extractEquibasePostTime(eq.postTimeRaw, card.date, card.track);
    }
    if (!pt && br?.postTimeRaw) {
      pt = extractBrisnetDrfPostTime(br.postTimeRaw, card.date, card.track);
    }
    if (!pt) {
      pt = fallbackPostTime(prev, card.date, card.track, n);
    }
    out.set(n, pt);
    prev = pt;
  }
  return out;
}

function main(): void {
  const races = sqlite
    .prepare(
      "SELECT id, card_id, race_number, post, post_time_utc FROM races ORDER BY card_id, race_number",
    )
    .all() as RaceRow[];

  const missing = races.filter(needsBackfill);
  console.log(
    `[backfill] ${races.length} races total; ${missing.length} need a post time.`,
  );
  if (missing.length === 0) {
    console.log("[backfill] nothing to do.");
    return;
  }

  // Group the cards that actually need work so we resolve each card once.
  const cardIds = Array.from(new Set(missing.map((r) => r.card_id)));
  const update = sqlite.prepare(
    "UPDATE races SET post = ?, post_time_utc = ? WHERE id = ?",
  );

  let touched = 0;
  const apply = sqlite.transaction(() => {
    for (const cardId of cardIds) {
      const card = sqlite
        .prepare("SELECT id, track, date FROM cards WHERE id = ?")
        .get(cardId) as CardRow | undefined;
      if (!card) continue;
      const resolved = resolveForCard(card);
      for (const r of missing.filter((x) => x.card_id === cardId)) {
        const pt = resolved.get(r.race_number);
        if (!pt) continue;
        console.log(
          `[backfill] card ${cardId} (${card.track} ${card.date}) race ${r.race_number} -> ${pt.display} (${pt.utcIso})`,
        );
        if (!DRY_RUN) update.run(pt.display, pt.utcIso, r.id);
        touched++;
      }
    }
  });
  apply();

  console.log(
    `[backfill] ${DRY_RUN ? "(dry-run) would touch" : "touched"} ${touched} race row(s).`,
  );
}

main();
