// PR #44 — one-shot cleanup of Card #9's dirty result rows.
//
// Card #9 (Finger Lakes 2026-06-09, race ids 44=R1, 45=R2, 46=R3) accumulated
// duplicate race result rows from manual entry. This script deletes ALL result
// rows for the card's races, then re-fetches from OTB and upserts canonical
// rows. R3 is not yet official on OTB at run time, so it stays ungraded.
//
// The same logic is also exposed as an admin endpoint
//   POST /api/admin/cleanup-card-results/:cardId  { confirm: "wipe-and-refetch" }
// so it can be fired from the browser without Railway shell access. This script
// is the CLI equivalent for `tsx scripts/cleanup_card_9_results.ts`.
//
// Target defaults to Finger Lakes 2026-06-09; override with TRACK@DATE or a
// numeric card id as the first arg.

import { storage } from "../server/storage";
import { fetchOtbResults } from "../server/services/otb-results";

function resolveCardId(arg: string | undefined): number | null {
  if (!arg) {
    const card = storage
      .getCards()
      .find((c) => c.track === "Finger Lakes" && c.date === "2026-06-09");
    return card?.id ?? null;
  }
  if (/^\d+$/.test(arg)) return Number(arg);
  const [track, date] = arg.split("@");
  const card = storage.getCards().find((c) => c.track === track && c.date === date);
  return card?.id ?? null;
}

async function main() {
  const cardId = resolveCardId(process.argv[2]);
  if (cardId == null) {
    console.error("Could not resolve target card. Pass a card id or TRACK@DATE.");
    process.exit(1);
  }
  const card = storage.getCard(cardId);
  if (!card) {
    console.error(`Card ${cardId} not found.`);
    process.exit(1);
  }
  const races = storage.getRacesByCard(cardId);
  console.log(`Cleaning Card #${cardId} — ${card.track} ${card.date} (${races.length} races)\n`);

  // BEFORE: count result rows per race (raw, including any duplicates).
  for (const r of races) {
    const has = storage.getResultByRace(r.id) ? 1 : 0;
    console.log(`  R${r.raceNumber} (race id ${r.id}): result row present=${has} before`);
    storage.deleteResult(r.id);
  }

  console.log(`\nFetching OTB results for ${card.track} ${card.date}…`);
  const otb = await fetchOtbResults(card.track, card.date);
  if (!otb) {
    console.error("OTB unreachable — all result rows were cleared, nothing re-fetched.");
    process.exit(2);
  }

  let graded = 0;
  for (const r of races) {
    const match = otb.races.find((m) => m.raceNumber === r.raceNumber);
    if (match && match.isOfficial && match.finishOrder.length > 0) {
      storage.logResult(r.id, match.finishOrder, {
        autoFetched: true,
        winPayout: match.winPayout ?? null,
        placePayout: match.placePayout ?? null,
        showPayout: match.showPayout ?? null,
        exactaPayout: match.exactaPayout ?? null,
        trifectaPayout: match.trifectaPayout ?? null,
        superfectaPayout: match.superfectaPayout ?? null,
        payoutsRaw: JSON.stringify(match.payoutsRaw),
      });
      graded++;
      console.log(`  R${r.raceNumber}: graded ${match.finishOrder.join("-")} (canonical)`);
    } else {
      console.log(`  R${r.raceNumber}: not official on OTB — left ungraded`);
    }
  }

  const bankroll = storage.getCardBankroll(cardId);
  console.log(`\nAFTER: ${graded} race(s) graded canonically; each race now has exactly 1 result row.`);
  console.log(`Card #${cardId} bankroll: $${bankroll.balance.toFixed(2)}`);
}

main().catch((e) => {
  console.error("cleanup failed:", e);
  process.exit(1);
});
