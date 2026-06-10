// OTB auto-grader cron (PR #44).
//
// Standing rule from the user: "5 mins after post time it should go out and look
// for the result then mark it official and update the bankroll." Every 5 minutes
// this sweep walks each ACTIVE card, finds races that are due (postTimeUtc + 5min
// ≤ now) and not yet officially graded, fetches the track's OTB results page, and
// upserts any official finishes — which flows through storage.logResult →
// bet_legs reconcile → bankroll race-grade event. A WS "race-graded" event then
// nudges the dashboard to refresh + toast.
//
// Pattern mirrors weather-cron.ts / scratch-refresh-cron.ts: a self-rescheduling
// setInterval (the repo has no node-cron dep). Kill switch: OTB_POLL_DISABLED=1.

import { sqlite } from "../db";
import { storage } from "../storage";
import { broadcastEvent } from "./events";
import { fetchOtbResults, type OtbRaceResult } from "./otb-results";
import { refreshMatticeWeight } from "./mattice-weight";

const POLL_MS = 5 * 60 * 1000;
const GRACE_MS = 5 * 60 * 1000; // wait 5 min past post before looking
let timer: NodeJS.Timeout | null = null;

interface ActiveCardRow {
  card_id: number;
  track: string;
  date: string;
}

function activeCards(): ActiveCardRow[] {
  return sqlite
    .prepare(
      `SELECT id AS card_id, track, date FROM cards
        WHERE status = 'active' AND locked = 1`,
    )
    .all() as ActiveCardRow[];
}

interface EligibleRaceRow {
  race_id: number;
  race_number: number;
  post_time_utc: string | null;
}

// Races on a card that are DUE (postTimeUtc + grace ≤ now) and not yet officially
// graded. "Officially graded" = a results row exists with a non-empty finish
// order (auto OR manual). Races with no post_time_utc are skipped (can't time
// them); the manual "Refresh from OTB" button covers those.
function eligibleRaces(cardId: number, now: number): EligibleRaceRow[] {
  const rows = sqlite
    .prepare(
      `SELECT r.id AS race_id, r.race_number AS race_number, r.post_time_utc AS post_time_utc
         FROM races r
        WHERE r.card_id = ?
          AND r.post_time_utc IS NOT NULL
          AND r.post_time_utc != ''
          AND NOT EXISTS (
            SELECT 1 FROM results res
             WHERE res.race_id = r.id AND res.finish_order IS NOT NULL AND res.finish_order != '[]'
          )`,
    )
    .all(cardId) as EligibleRaceRow[];
  return rows.filter((r) => {
    const ms = Date.parse(r.post_time_utc as string);
    return Number.isFinite(ms) && now >= ms + GRACE_MS;
  });
}

// Upsert one OTB race result into storage and append its bankroll event. Returns
// true if it graded (official + had a finish order). Shared by the cron and the
// per-race manual auto-grade route.
// HARD GUARD against phantom grades (PR #45). The parser can return a stub race
// for a not-yet-official day (Card #9 R4 got a -$167 phantom event off an empty
// OTB stub page). Never write a result row / bankroll event unless the race is
// genuinely official: has an isOfficial flag, a non-empty finish order, a
// declared winner, AND at least one real signal (a winner pgm or any payout).
export function isGradableOtbRace(otb: OtbRaceResult): boolean {
  if (!otb.isOfficial) return false;
  if (!otb.finishOrder || otb.finishOrder.length === 0) return false;
  if (!otb.winPgm) return false;
  // A genuine official race has a winner pgm + finish order (checked above). An
  // all-null/zero stub never gets this far, so a declared winner is sufficient.
  return true;
}

export function gradeRaceFromOtb(
  raceId: number,
  raceNumber: number,
  otb: OtbRaceResult,
): boolean {
  if (!isGradableOtbRace(otb)) return false;
  const result = storage.logResult(raceId, otb.finishOrder, {
    autoFetched: true,
    winPayout: otb.winPayout ?? null,
    placePayout: otb.placePayout ?? null,
    showPayout: otb.showPayout ?? null,
    exactaPayout: otb.exactaPayout ?? null,
    trifectaPayout: otb.trifectaPayout ?? null,
    superfectaPayout: otb.superfectaPayout ?? null,
    payoutsRaw: JSON.stringify(otb.payoutsRaw),
  });
  // Mattice overlay auto-grade: fill won/in_money for the race's overlay
  // predictions, then refresh the weight phase from the accumulated record.
  // A $2 win mutuel maps the overlay's top horse to its ROI when it won.
  try {
    storage.gradeMatticeForRace(raceId, otb.finishOrder);
    const payoutByKey = new Map<string, number>();
    if (otb.winPayout != null && otb.winPgm != null) {
      payoutByKey.set(`${raceId}:${String(otb.winPgm)}`, otb.winPayout);
    }
    refreshMatticeWeight({ payoutByKey });
  } catch (e) {
    console.error(`[mattice] grade/refresh failed race ${raceId}:`, e);
  }

  const race = storage.getRace(raceId);
  const bankroll = race ? storage.getCardBankroll(race.cardId) : null;
  broadcastEvent("race-graded", {
    raceId,
    raceNumber,
    cardId: race?.cardId ?? null,
    winnerPgm: otb.winPgm ?? result.finishOrder,
    winnerName: otb.finishers[0]?.horse ?? null,
    balance: bankroll?.balance ?? null,
  });
  return true;
}

// Auto-grade a single race on demand (manual "Refresh from OTB" button). Fetches
// the race's card track/date page and grades just that race. Returns a small
// status object; never throws (OTB unreachable → graded:false).
export async function autoGradeRace(
  raceId: number,
  now: number = Date.now(),
): Promise<{ graded: boolean; reason?: string; raceNumber?: number }> {
  const race = storage.getRace(raceId);
  if (!race) return { graded: false, reason: "race not found" };
  const card = storage.getCard(race.cardId);
  if (!card) return { graded: false, reason: "card not found" };
  const otb = await fetchOtbResults(card.track, card.date, now);
  if (!otb) return { graded: false, reason: "OTB unreachable", raceNumber: race.raceNumber };
  const match = otb.races.find((r) => r.raceNumber === race.raceNumber);
  if (!match) return { graded: false, reason: "race not on OTB page", raceNumber: race.raceNumber };
  if (!isGradableOtbRace(match)) return { graded: false, reason: "not yet official", raceNumber: race.raceNumber };
  const graded = gradeRaceFromOtb(raceId, race.raceNumber, match);
  return { graded, raceNumber: race.raceNumber };
}

// One full sweep across all active locked cards. Returns counts for the log line.
export async function runResultsPollOnce(
  now: number = Date.now(),
): Promise<{ cards: number; eligible: number; graded: number }> {
  const cards = activeCards();
  let eligibleTotal = 0;
  let gradedTotal = 0;
  for (const card of cards) {
    const due = eligibleRaces(card.card_id, now);
    if (due.length === 0) continue;
    eligibleTotal += due.length;
    const otb = await fetchOtbResults(card.track, card.date, now);
    if (!otb) {
      console.log(
        `[otb-poll] card ${card.card_id} (${card.track} ${card.date}): OTB unreachable, ${due.length} due`,
      );
      continue;
    }
    for (const race of due) {
      const match = otb.races.find((r) => r.raceNumber === race.race_number);
      if (!match || !isGradableOtbRace(match)) {
        if (match) {
          console.log(
            `[otb-poll] card ${card.card_id} R${race.race_number}: sentinel skip (not yet official / empty grade)`,
          );
        }
        continue;
      }
      try {
        if (gradeRaceFromOtb(race.race_id, race.race_number, match)) gradedTotal++;
      } catch (e) {
        console.error(`[otb-poll] grade failed race ${race.race_id}:`, e);
      }
    }
  }
  console.log(
    `[otb-poll] ${cards.length} active card(s), ${eligibleTotal} race(s) eligible, ${gradedTotal} graded`,
  );
  return { cards: cards.length, eligible: eligibleTotal, graded: gradedTotal };
}

function scheduleSweep(): void {
  runResultsPollOnce().catch((e) => console.error("[otb-poll] sweep error:", e));
}

export function startResultsPollerCron(): void {
  if (process.env.OTB_POLL_DISABLED === "1") {
    console.log("[otb-poll] disabled via OTB_POLL_DISABLED=1");
    return;
  }
  if (timer) return;
  // Run shortly after boot, then every 5 minutes.
  setTimeout(scheduleSweep, 30 * 1000).unref?.();
  timer = setInterval(scheduleSweep, POLL_MS);
  timer.unref?.();
  console.log("[otb-poll] scheduled — every 5 min for active cards (post+5min)");
}
