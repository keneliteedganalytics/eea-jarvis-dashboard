// One-shot scratch backfill (PR #20).
//
// Runs refreshScratchesForCard on every LOCKED card dated today, applying any
// morning scratches that came out after the card was ingested. Idempotent: a
// second run with no roster change reports zero new scratches. Safe to re-run.
//
// Usage:  tsx scripts/refresh_all_scratches.ts [YYYY-MM-DD]
//   With no arg it targets today's UTC date.

import { storage } from "../server/storage";
import {
  refreshScratchesForCard,
  isScratchRefreshError,
} from "../server/services/scratch-refresh";

function main(): void {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const cards = storage
    .getCards()
    .filter((c) => c.locked && c.date === date);

  console.log(
    `[refresh-all] ${cards.length} locked card(s) for ${date}.`,
  );
  if (cards.length === 0) {
    console.log("[refresh-all] nothing to do.");
    return;
  }

  let totalScratched = 0;
  let totalReinstated = 0;
  for (const card of cards) {
    const result = refreshScratchesForCard(card.id);
    if (isScratchRefreshError(result)) {
      console.log(
        `[refresh-all] card ${card.id} (${card.track}) skipped: ${result.reason}`,
      );
      continue;
    }
    totalScratched += result.newScratches.length;
    totalReinstated += result.reinstated.length;
    console.log(
      `[refresh-all] card ${card.id} (${card.track}): ${result.racesChecked} races, ` +
        `${result.newScratches.length} scratched, ${result.reinstated.length} reinstated, ` +
        `${result.unchangedCount} unchanged`,
    );
    for (const s of result.newScratches) {
      console.log(`  - SCRATCHED  R${s.raceNumber} #${s.horsePgm} ${s.horseName}`);
    }
    for (const s of result.reinstated) {
      console.log(`  + REINSTATED R${s.raceNumber} #${s.horsePgm} ${s.horseName}`);
    }
  }

  console.log(
    `[refresh-all] done — ${totalScratched} scratched, ${totalReinstated} reinstated across ${cards.length} card(s).`,
  );
}

main();
