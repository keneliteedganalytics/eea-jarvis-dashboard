// PR #51 — one-shot Mattice overlay backfill for an already-ingested card.
// PR #52 — core logic extracted to server/services/mattice-backfill.ts so the
// same run is available over HTTP (POST /api/cards/:id/mattice-backfill). This
// script is now a thin CLI wrapper that resolves a card id, runs the shared
// function, and pretty-prints the result.
//
// Target defaults to cardId 11 (Finger Lakes 2026-06-10); override with a
// numeric card id as the first arg:  tsx scripts/backfill_mattice_card.ts 11

import { storage } from "../server/storage";
import { runMatticeBackfill } from "../server/services/mattice-backfill";

function resolveCardId(arg: string | undefined): number | null {
  if (arg && /^\d+$/.test(arg)) return Number(arg);
  const card = storage
    .getCards()
    .find((c) => c.track === "Finger Lakes" && c.date === "2026-06-10");
  return card?.id ?? null;
}

function main() {
  const cardId = resolveCardId(process.argv[2]);
  if (cardId == null) {
    console.error("backfill_mattice: could not resolve a card id");
    process.exit(1);
  }

  let result;
  try {
    result = runMatticeBackfill(cardId);
  } catch (e) {
    console.error(`backfill_mattice: ${(e as Error).message}`);
    process.exit(1);
  }

  const { card, phase, races, skippedRaces, tierDistribution, gradedRaces, stats } = result;
  console.log(
    `\n=== Mattice backfill — card ${card.id} (${card.track} ${card.date}), phase ${phase} ===\n`,
  );

  for (const r of races) {
    console.log(
      `R${r.raceNumber}: tier ${r.oldTier}→${r.newTier}` +
        `${r.tiebreakApplied ? ` | tiebreak` : ""}` +
        `${r.vetoApplied ? " | VETO" : ""}` +
        `${r.matticeConfirmed ? " | CONFIRMED" : ""}` +
        ` | Mattice top #${r.matticeTopPgm} (${r.matticeTopScore ?? "?"}/100)` +
        `${r.note ? `\n     ${r.note}` : ""}`,
    );
  }
  for (const rn of skippedRaces) {
    console.log(`R${rn}: no preserved predictions — skipped`);
  }

  console.log(`\n--- Tier distribution ---`);
  const tiers = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"];
  for (const t of tiers) {
    const b = tierDistribution.before[t] ?? 0;
    const a = tierDistribution.after[t] ?? 0;
    if (b || a) console.log(`  ${t.padEnd(7)} ${b} → ${a}`);
  }

  console.log(`\n--- Mattice running stats ---`);
  console.log(`  graded races (overlay): ${gradedRaces} this card; N=${stats.n} lifetime`);
  console.log(
    `  Mattice top win%: ${stats.matticeTopWinPct?.toFixed(1) ?? "—"}%` +
      `  |  system win%: ${stats.equibaseFavWinPct?.toFixed(1) ?? "—"}%`,
  );
  console.log(`  flat $2 top-pick ROI: ${stats.roiPct?.toFixed(1) ?? "—"}%  |  vetoes: ${stats.vetoCount}`);
  console.log(`  weight phase: ${stats.weightPhase} (${stats.phaseLabel})`);
  if (stats.phaseReason) console.log(`  phase reason: ${stats.phaseReason}`);
  console.log("");
}

main();
