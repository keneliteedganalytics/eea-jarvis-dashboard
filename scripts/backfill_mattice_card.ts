// PR #51 — one-shot Mattice overlay backfill for an already-ingested card.
//
// Re-runs the Mattice 5-factor overlay across every race of a card WITHOUT
// re-ingesting Equibase/Brisnet. It reconstructs each FusedRace from the
// preserved predictions snapshot (the same path fusion-replay uses), runs the
// overlay at the card's current weight phase (Phase 1 = tiebreak + veto only),
// persists the per-horse Mattice predictions, and applies the tiebreak win-pick
// swap + veto tier downgrade + "Mattice Confirmed" badge to each race row. If a
// race already has a graded result, the overlay predictions are auto-graded and
// the weight phase is refreshed from the accumulated record.
//
// Target defaults to cardId 11 (Finger Lakes 2026-06-10); override with a
// numeric card id as the first arg:  tsx scripts/backfill_mattice_card.ts 11

import { storage } from "../server/storage";
import { reconstructFusedRace } from "../server/services/fusion-replay";
import { applyOverlay, persistMatticePredictions } from "../server/services/mattice-overlay";
import { refreshMatticeWeight, PHASE_TIEBREAK } from "../server/services/mattice-weight";
import type { Tier } from "../server/services/eea-fusion";

function resolveCardId(arg: string | undefined): number | null {
  if (arg && /^\d+$/.test(arg)) return Number(arg);
  const card = storage
    .getCards()
    .find((c) => c.track === "Finger Lakes" && c.date === "2026-06-10");
  return card?.id ?? null;
}

function finishOrderFor(resultJson: string | null | undefined): string[] {
  if (!resultJson) return [];
  try {
    const fo = JSON.parse(resultJson) as unknown;
    return Array.isArray(fo) ? fo.map(String) : [];
  } catch {
    return [];
  }
}

function main() {
  const cardId = resolveCardId(process.argv[2]);
  if (cardId == null) {
    console.error("backfill_mattice: could not resolve a card id");
    process.exit(1);
  }
  const card = storage.getCardWithRaces(cardId);
  if (!card) {
    console.error(`backfill_mattice: card ${cardId} not found`);
    process.exit(1);
  }

  const phase = storage.getSettings().matticeWeightPhase ?? PHASE_TIEBREAK;
  console.log(
    `\n=== Mattice backfill — card ${card.id} (${card.track} ${card.date}), phase ${phase} ===\n`,
  );

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const bump = (m: Record<string, number>, t: string) => (m[t] = (m[t] ?? 0) + 1);

  let gradedRaces = 0;
  for (const race of card.races) {
    const preds = storage.getPredictionsByRace(race.id);
    if (preds.length === 0) {
      console.log(`R${race.raceNumber}: no preserved predictions — skipped`);
      continue;
    }
    bump(before, race.tier);

    const fused = reconstructFusedRace(race, preds);
    const leaderTier = race.tier as Tier;
    const overlay = applyOverlay(fused, leaderTier, phase);

    // Persist the overlay's per-horse predictions.
    persistMatticePredictions({
      cardId: card.id,
      raceId: race.id,
      scores: overlay.scores,
      systemWinPgm: overlay.tiebreakApplied ? overlay.winPgm : (race.winPgm ?? null),
      matticeTopPgm: overlay.matticeTopPgm,
    });

    // Apply the overlay result to the race row (win-pick swap + veto downgrade
    // + confirmed badge). Leave WPS picks otherwise intact.
    const patch: Record<string, unknown> = {
      tier: overlay.tier,
      matticeConfirmed: overlay.confirmed,
    };
    if (overlay.tiebreakApplied && overlay.winPgm && overlay.winPgm !== race.winPgm) {
      const newWin = fused.horses.find((h) => h.pgm === overlay.winPgm);
      if (newWin) {
        patch.winPgm = newWin.pgm;
        patch.winName = newWin.name;
      }
    }
    storage.updateRaceFusion(race.id, patch);
    bump(after, String(overlay.tier));

    const topScore = overlay.scores.find((s) => s.programNumber === overlay.matticeTopPgm);
    console.log(
      `R${race.raceNumber}: tier ${race.tier}→${overlay.tier}` +
        `${overlay.tiebreakApplied ? ` | tiebreak→#${overlay.winPgm}` : ""}` +
        `${overlay.vetoApplied ? " | VETO" : ""}` +
        `${overlay.confirmed ? " | CONFIRMED" : ""}` +
        ` | Mattice top #${overlay.matticeTopPgm} (${topScore?.matticeScore ?? "?"}/100)` +
        `${overlay.note ? `\n     ${overlay.note}` : ""}`,
    );

    // Auto-grade if the race already has a result.
    const finishOrder = finishOrderFor(race.result?.finishOrder);
    if (finishOrder.length > 0) {
      storage.gradeMatticeForRace(race.id, finishOrder);
      gradedRaces++;
    }
  }

  // Refresh the weight phase from the freshly-graded record.
  const stats = refreshMatticeWeight();

  console.log(`\n--- Tier distribution ---`);
  const tiers = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"];
  for (const t of tiers) {
    const b = before[t] ?? 0;
    const a = after[t] ?? 0;
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
