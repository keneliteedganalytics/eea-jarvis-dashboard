// Per-card bankroll ledger (PR #44).
//
// Each card runs its own $1000 bankroll (the user's standing "$1k risk per card"
// rule). On card create a `card-start` event of +$1000 seeds the ledger; on each
// race grade a `race-grade` event is appended whose delta is the net for that
// race = sum(live leg payouts) − sum(live leg costs). The running balance is
// denormalized onto each row so the header pill reads in one query.
//
// Uses the raw `db` handle (not storage) to avoid a circular import: storage
// imports services, and the auto-grader/cron import this.

import { db } from "../db";
import { bankrollEvents, betLegs } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import type { BankrollEventRow } from "@shared/schema";

export const STARTING_BANKROLL = 1000;

export type BankrollSource =
  | "card-start"
  | "race-grade"
  | "manual-adjust"
  | "bet-placed";

// Sum of all deltas for a card = its current balance. Empty ledger → 0.
export function getCardBalance(cardId: number): number {
  const rows = db
    .select({ delta: bankrollEvents.delta })
    .from(bankrollEvents)
    .where(eq(bankrollEvents.cardId, cardId))
    .all();
  const total = rows.reduce((acc, r) => acc + (r.delta ?? 0), 0);
  return Math.round(total * 100) / 100;
}

export function getCardLedger(cardId: number): BankrollEventRow[] {
  return db
    .select()
    .from(bankrollEvents)
    .where(eq(bankrollEvents.cardId, cardId))
    .orderBy(desc(bankrollEvents.id))
    .all();
}

// Append one ledger event. runningBalance is computed from the current balance +
// delta so the denormalized column always reflects post-event state.
export function appendBankrollEvent(
  cardId: number,
  raceId: number | null,
  source: BankrollSource,
  delta: number,
  note?: string,
): BankrollEventRow {
  const rounded = Math.round(delta * 100) / 100;
  const runningBalance = Math.round((getCardBalance(cardId) + rounded) * 100) / 100;
  return db
    .insert(bankrollEvents)
    .values({
      cardId,
      raceId: raceId ?? null,
      source,
      delta: rounded,
      runningBalance,
      note: note ?? null,
    })
    .returning()
    .get();
}

// Seed a new card with its +$1000 starting bankroll. Idempotent: a card that
// already has a card-start event is left untouched (safe to call on every
// create path / re-import).
export function seedCardBankroll(cardId: number): void {
  const existing = db
    .select({ id: bankrollEvents.id })
    .from(bankrollEvents)
    .where(and(eq(bankrollEvents.cardId, cardId), eq(bankrollEvents.source, "card-start")))
    .get();
  if (existing) return;
  appendBankrollEvent(cardId, null, "card-start", STARTING_BANKROLL, "Daily risk budget");
}

// Net dollars for a race from its LIVE (non-refunded) bet legs:
// sum(payout) − sum(cost). Refunded legs (scratched re-tiers) are excluded — the
// stake was returned, so they neither win nor lose. Legs without an entered
// payout (hit but unknown return) contribute 0 to the payout side.
export function raceNetFromLegs(raceId: number): number {
  const legs = db
    .select({ cost: betLegs.cost, payout: betLegs.payout })
    .from(betLegs)
    .where(and(eq(betLegs.raceId, raceId), eq(betLegs.refunded, false)))
    .all();
  let net = 0;
  for (const leg of legs) {
    net += (leg.payout ?? 0) - (leg.cost ?? 0);
  }
  return Math.round(net * 100) / 100;
}

// Record a race grade on the card's ledger. Idempotent per (card, race): if a
// race-grade event already exists for this race (e.g. a re-grade after a payout
// backfill), it is replaced so the balance reflects the latest numbers rather
// than double-counting. Returns the appended event, or null when net is exactly
// what's already recorded (no-op).
export function recordRaceGrade(
  cardId: number,
  raceId: number,
  note?: string,
): BankrollEventRow | null {
  const net = raceNetFromLegs(raceId);
  const prior = db
    .select()
    .from(bankrollEvents)
    .where(
      and(
        eq(bankrollEvents.cardId, cardId),
        eq(bankrollEvents.raceId, raceId),
        eq(bankrollEvents.source, "race-grade"),
      ),
    )
    .get();
  if (prior) {
    if (Math.round((prior.delta ?? 0) * 100) === Math.round(net * 100)) return null;
    db.delete(bankrollEvents).where(eq(bankrollEvents.id, prior.id)).run();
  }
  return appendBankrollEvent(cardId, raceId, "race-grade", net, note);
}
