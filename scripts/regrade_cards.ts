// PR #42 — re-grade graded cards under the recalibrated model.
//
// Rebuilds each target card's bet_legs ledger (so betBudgetVersion>=2 cards pick
// up the new tier weights EDGE 25 / DUAL 6 and the Maiden-Claim EX-only gate),
// re-reconciles every race against its stored result, and refreezes
// card_summaries (recomputing ROI + the new PASS-WIN MISS columns). Prints a
// before/after ROI delta per card so the PR report can cite the numbers.
//
// Targets default to the two graded cards named in the PR #42 spec:
//   Card #4 — Finger Lakes 2026-06-01
//   Card #8 — Finger Lakes 2026-06-09
// Override by passing identifiers: a numeric card id, or TRACK@DATE
// (e.g. "Finger Lakes@2026-06-01"). --dry-run reports the before-state only.
//
// Usage:
//   tsx scripts/regrade_cards.ts
//   tsx scripts/regrade_cards.ts 4 8
//   tsx scripts/regrade_cards.ts "Finger Lakes@2026-06-01" "Finger Lakes@2026-06-09"
//   tsx scripts/regrade_cards.ts --dry-run

import { storage } from "../server/storage";

interface Target {
  label: string;
  cardId?: number;
  track?: string;
  date?: string;
}

const DEFAULT_TARGETS: Target[] = [
  { label: "Card #4", track: "Finger Lakes", date: "2026-06-01" },
  { label: "Card #8", track: "Finger Lakes", date: "2026-06-09" },
];

function parseArgs(argv: string[]): { dryRun: boolean; targets: Target[] } {
  const dryRun = argv.includes("--dry-run");
  const ids = argv.filter((a) => a !== "--dry-run");
  if (ids.length === 0) return { dryRun, targets: DEFAULT_TARGETS };
  const targets: Target[] = ids.map((raw) => {
    if (/^\d+$/.test(raw)) return { label: `Card id ${raw}`, cardId: Number(raw) };
    const [track, date] = raw.split("@");
    return { label: `${track} ${date}`, track, date };
  });
  return { dryRun, targets };
}

function resolveCardId(t: Target): number | undefined {
  if (t.cardId != null) return t.cardId;
  const hit = storage.getCards().find((c) => c.track === t.track && c.date === t.date);
  return hit?.id;
}

function roiOf(cardId: number): number | null {
  const s = storage.getCardSummary(cardId);
  return s?.roiPct ?? null;
}

function fmt(roi: number | null): string {
  return roi == null ? "n/a" : `${roi > 0 ? "+" : ""}${roi}%`;
}

function main(): void {
  const { dryRun, targets } = parseArgs(process.argv.slice(2));
  console.log(`PR #42 re-grade${dryRun ? " (DRY RUN — no writes)" : ""}\n`);

  for (const t of targets) {
    const cardId = resolveCardId(t);
    if (cardId == null) {
      console.log(`✗ ${t.label}: card not found — skipping`);
      continue;
    }
    const card = storage.getCard(cardId);
    const before = roiOf(cardId);
    const version = card?.betBudgetVersion ?? 1;

    if (dryRun) {
      console.log(
        `• ${t.label} (id ${cardId}, v${version}): current ROI ${fmt(before)} — would re-grade`,
      );
      continue;
    }

    const summary = storage.regradeCard(cardId);
    const after = summary?.roiPct ?? null;
    const delta =
      before != null && after != null
        ? `${after - before > 0 ? "+" : ""}${Math.round((after - before) * 10) / 10} pts`
        : "n/a";
    const misses = summary?.passWinMissCount ?? 0;
    console.log(
      `✓ ${t.label} (id ${cardId}, v${version}): ROI ${fmt(before)} → ${fmt(after)} (${delta}); ` +
        `PASS-WIN misses: ${misses}`,
    );
  }
  console.log("\nDone.");
}

main();
