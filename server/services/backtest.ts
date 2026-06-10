import { db } from "../db";
import { cards, cardSnapshots, cardOutcomes } from "@shared/schema";
import type {
  CardSnapshotRow,
  CardOutcomeRow,
  SnapshotSubmit,
  OutcomeSubmit,
  BacktestTierRoi,
  BacktestSnapshotSummary,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

export const DEFAULT_METHODOLOGY_VERSION = "card10-v1";
const TIERS = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;
type Tier = (typeof TIERS)[number];

// The shape we expect inside card_snapshots.scoring. It's stored as a free-form
// JSON blob, but the ROI simulator reads this structure: one entry per race
// carrying the assigned tier and the concrete bet that was placed. `bet` is the
// thing we settle against the recorded outcome — e.g. { type: "WIN", horseId:
// "5", stake: 210 } means a $210 win bet on program 5. Races with no bet (PASS)
// simply omit `bet` or set tier PASS.
export interface ScoringBet {
  type: "WIN" | "PLACE" | "SHOW" | "EXACTA";
  horseId: string; // program number / horse name keying into card_outcomes
  stake: number; // dollars
  combo?: string; // for EXACTA: ordered pgms "5-1" to match exactaPayout key
}
export interface ScoringRace {
  raceNum: number;
  tier: Tier | string;
  bet?: ScoringBet | null;
}
export interface ScoringBlob {
  races?: ScoringRace[];
}

function emptyTierCounts(): BacktestSnapshotSummary["tiersByCount"] {
  return { SNIPER: 0, EDGE: 0, DUAL: 0, RECON: 0, PASS: 0 };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────
// Idempotent on (cardId, methodologyVersion): an existing snapshot for the pair
// is replaced so the latest score-time state wins without piling up duplicates.
export function upsertSnapshot(cardId: number, body: SnapshotSubmit): CardSnapshotRow {
  const methodologyVersion = body.methodologyVersion ?? DEFAULT_METHODOLOGY_VERSION;
  const rawData = JSON.stringify(body.rawData ?? {});
  const scoring = JSON.stringify(body.scoring ?? {});

  db.delete(cardSnapshots)
    .where(
      and(
        eq(cardSnapshots.cardId, cardId),
        eq(cardSnapshots.methodologyVersion, methodologyVersion),
      ),
    )
    .run();

  return db
    .insert(cardSnapshots)
    .values({
      cardId,
      methodologyVersion,
      rawData,
      scoring,
      bankrollAllocated: body.bankrollAllocated,
      bankrollCap: body.bankrollCap,
    })
    .returning()
    .get();
}

export function getSnapshot(
  cardId: number,
  methodologyVersion = DEFAULT_METHODOLOGY_VERSION,
): CardSnapshotRow | undefined {
  return db
    .select()
    .from(cardSnapshots)
    .where(
      and(
        eq(cardSnapshots.cardId, cardId),
        eq(cardSnapshots.methodologyVersion, methodologyVersion),
      ),
    )
    .get();
}

// ── Outcomes ──────────────────────────────────────────────────────────────
// Upsert per (cardId, raceNum, horseId): recording a horse again overwrites its
// row so a correction (e.g. a late payout) replaces the prior value.
export function recordOutcomes(cardId: number, rows: OutcomeSubmit[]): CardOutcomeRow[] {
  const out: CardOutcomeRow[] = [];
  for (const r of rows) {
    db.delete(cardOutcomes)
      .where(
        and(
          eq(cardOutcomes.cardId, cardId),
          eq(cardOutcomes.raceNum, r.raceNum),
          eq(cardOutcomes.horseId, r.horseId),
        ),
      )
      .run();
    const inserted = db
      .insert(cardOutcomes)
      .values({
        cardId,
        raceNum: r.raceNum,
        horseId: r.horseId,
        finishPosition: r.finishPosition ?? null,
        winPayout: r.winPayout ?? null,
        placePayout: r.placePayout ?? null,
        showPayout: r.showPayout ?? null,
        exactaPayout: r.exactaPayout ?? null,
      })
      .returning()
      .get();
    out.push(inserted);
  }
  return out;
}

// ── Snapshots summary ────────────────────────────────────────────────────
export function listSnapshots(
  methodologyVersion = DEFAULT_METHODOLOGY_VERSION,
): BacktestSnapshotSummary[] {
  const snaps = db
    .select()
    .from(cardSnapshots)
    .where(eq(cardSnapshots.methodologyVersion, methodologyVersion))
    .all();

  return snaps.map((s) => {
    const card = db.select().from(cards).where(eq(cards.id, s.cardId)).get();
    const blob = safeParse<ScoringBlob>(s.scoring, {});
    const races = blob.races ?? [];
    const tiers = emptyTierCounts();
    for (const r of races) {
      const t = (r.tier ?? "").toUpperCase();
      if (t in tiers) tiers[t as Tier] += 1;
    }
    return {
      cardId: s.cardId,
      date: card?.date ?? "",
      track: card?.track ?? "",
      snapshotAt: s.snapshotAt,
      methodologyVersion: s.methodologyVersion,
      raceCount: races.length,
      tiersByCount: tiers,
    };
  });
}

// ── ROI ──────────────────────────────────────────────────────────────────
// Per-tier ROI computed by joining each snapshot's frozen scoring to the
// recorded outcomes. For each (snapshot, race) where an outcome exists, we
// simulate the snapshot's bet and settle it against the actual payout. Payouts
// are $2-base (the dashboard's convention everywhere else), so a WIN bet returns
// stake/2 * winPayout; place/show analogous; an exacta returns stake/2 *
// exactaPayout when the combo matches the finish.
interface TierAccum {
  bets: number;
  wins: number;
  totalStaked: number;
  totalReturned: number;
}

function settleBet(
  bet: ScoringBet,
  outcomesByHorse: Map<string, CardOutcomeRow>,
  finishByPos: Map<number, string>,
): { staked: number; returned: number; won: boolean } {
  const staked = bet.stake;
  const o = outcomesByHorse.get(bet.horseId);
  if (!o) return { staked, returned: 0, won: false };

  const base = staked / 2;
  switch (bet.type) {
    case "WIN": {
      if (o.finishPosition === 1 && o.winPayout != null) {
        return { staked, returned: base * o.winPayout, won: true };
      }
      return { staked, returned: 0, won: false };
    }
    case "PLACE": {
      if (o.finishPosition != null && o.finishPosition <= 2 && o.placePayout != null) {
        return { staked, returned: base * o.placePayout, won: true };
      }
      return { staked, returned: 0, won: false };
    }
    case "SHOW": {
      if (o.finishPosition != null && o.finishPosition <= 3 && o.showPayout != null) {
        return { staked, returned: base * o.showPayout, won: true };
      }
      return { staked, returned: 0, won: false };
    }
    case "EXACTA": {
      // combo "5-1" must match positions 1 then 2. exactaPayout lives on the
      // winning horse's outcome row (winPayout!=null), stored as a string.
      const combo = (bet.combo ?? "").split("-").map((s) => s.trim()).filter(Boolean);
      if (combo.length === 2 && finishByPos.get(1) === combo[0] && finishByPos.get(2) === combo[1]) {
        const winnerRow = outcomesByHorse.get(combo[0]);
        const exVal = winnerRow?.exactaPayout != null ? Number(winnerRow.exactaPayout) : NaN;
        if (Number.isFinite(exVal)) return { staked, returned: base * exVal, won: true };
      }
      return { staked, returned: 0, won: false };
    }
    default:
      return { staked, returned: 0, won: false };
  }
}

export interface BacktestRoiReport {
  methodologyVersion: string;
  cardCount: number;
  raceCount: number;
  settledBetCount: number;
  tiers: Record<string, BacktestTierRoi>;
}

export function computeRoi(
  methodologyVersion = DEFAULT_METHODOLOGY_VERSION,
): BacktestRoiReport {
  const snaps = db
    .select()
    .from(cardSnapshots)
    .where(eq(cardSnapshots.methodologyVersion, methodologyVersion))
    .all();

  const accum: Record<string, TierAccum> = {};
  for (const t of TIERS) accum[t] = { bets: 0, wins: 0, totalStaked: 0, totalReturned: 0 };

  let raceCount = 0;
  let settledBetCount = 0;

  for (const s of snaps) {
    const outcomes = db
      .select()
      .from(cardOutcomes)
      .where(eq(cardOutcomes.cardId, s.cardId))
      .all();
    // Group outcomes by race for O(1) per-race lookup.
    const byRace = new Map<number, CardOutcomeRow[]>();
    for (const o of outcomes) {
      const arr = byRace.get(o.raceNum) ?? [];
      arr.push(o);
      byRace.set(o.raceNum, arr);
    }

    const blob = safeParse<ScoringBlob>(s.scoring, {});
    for (const race of blob.races ?? []) {
      raceCount += 1;
      const tier = (race.tier ?? "").toUpperCase();
      const bet = race.bet;
      if (!bet || !(tier in accum)) continue;

      const raceOutcomes = byRace.get(race.raceNum);
      if (!raceOutcomes || raceOutcomes.length === 0) continue; // no outcome yet → not settled

      const outcomesByHorse = new Map<string, CardOutcomeRow>();
      const finishByPos = new Map<number, string>();
      for (const o of raceOutcomes) {
        outcomesByHorse.set(o.horseId, o);
        if (o.finishPosition != null) finishByPos.set(o.finishPosition, o.horseId);
      }

      const { staked, returned, won } = settleBet(bet, outcomesByHorse, finishByPos);
      const a = accum[tier];
      a.bets += 1;
      if (won) a.wins += 1;
      a.totalStaked += staked;
      a.totalReturned += returned;
      settledBetCount += 1;
    }
  }

  const tiers: Record<string, BacktestTierRoi> = {};
  for (const t of TIERS) {
    const a = accum[t];
    const roi =
      a.totalStaked > 0 ? ((a.totalReturned - a.totalStaked) / a.totalStaked) * 100 : null;
    tiers[t] = {
      tier: t,
      bets: a.bets,
      wins: a.wins,
      totalStaked: Math.round(a.totalStaked * 100) / 100,
      totalReturned: Math.round(a.totalReturned * 100) / 100,
      roi: roi == null ? null : Math.round(roi * 100) / 100,
      sampleSize: a.bets,
    };
  }

  return {
    methodologyVersion,
    cardCount: snaps.length,
    raceCount,
    settledBetCount,
    tiers,
  };
}
