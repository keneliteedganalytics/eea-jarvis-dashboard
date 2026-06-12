import { storage } from "./storage";
import type { RealBetRow } from "@shared/schema";

// Book Bets analytics. Operates on the real_bets table (Ken's actual placed
// sportsbook bets) — independent of the Jarvis bet_legs ledger. P/L is the
// realized payout minus what was wagered; REFUND rows net to zero (payout
// equals cost on a refund) so they neither help nor hurt ROI.

export interface BookScope {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inScope(b: RealBetRow, opts: BookScope): boolean {
  if (opts.from && b.date < opts.from) return false;
  if (opts.to && b.date > opts.to) return false;
  return true;
}

function scopedBets(opts: BookScope): RealBetRow[] {
  return storage.getAllRealBets().filter((b) => inScope(b, opts));
}

function pnlOf(b: RealBetRow): number {
  return b.payout - b.totalCost;
}

function roiPct(cost: number, payout: number): number {
  if (cost <= 0) return 0;
  return round1(((payout - cost) / cost) * 100);
}

function summarize(bets: RealBetRow[]) {
  const totalBets = bets.length;
  const totalCost = round2(bets.reduce((s, b) => s + b.totalCost, 0));
  const totalPayout = round2(bets.reduce((s, b) => s + b.payout, 0));
  const totalPnl = round2(totalPayout - totalCost);
  const roi = roiPct(totalCost, totalPayout);
  const wins = bets.filter((b) => b.result === "WIN").length;
  const winPct = totalBets > 0 ? round1((wins / totalBets) * 100) : 0;
  return { totalBets, totalCost, totalPayout, totalPnl, roi, winPct };
}

export function buildBookSummary(opts: BookScope = {}) {
  return summarize(scopedBets(opts));
}

export function buildBookByTrack(opts: BookScope = {}) {
  const groups = new Map<string, RealBetRow[]>();
  for (const b of scopedBets(opts)) {
    const k = b.track;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  return Array.from(groups.entries())
    .map(([track, bets]) => ({ track, ...summarize(bets) }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function buildBookByBetType(opts: BookScope = {}) {
  const groups = new Map<string, RealBetRow[]>();
  for (const b of scopedBets(opts)) {
    const k = b.betType;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  return Array.from(groups.entries())
    .map(([betType, bets]) => ({ betType, ...summarize(bets) }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function buildBookByTrackAndType(opts: BookScope = {}) {
  // Key on a tab-joined composite so multi-word track names ("Belmont at the
  // Big A") don't collide with the bet type when we split them back out.
  const groups = new Map<string, RealBetRow[]>();
  for (const b of scopedBets(opts)) {
    const k = `${b.track}\t${b.betType}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  return Array.from(groups.entries())
    .map(([k, bets]) => {
      const [track, betType] = k.split("\t");
      return { track, betType, ...summarize(bets) };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

// Cumulative P/L over time, ordered by when each bet was placed. The frontend
// plots this as a bankroll curve.
export function buildBookBankrollCurve(opts: BookScope = {}) {
  const bets = scopedBets(opts)
    .slice()
    .sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0));
  let cumulative = 0;
  return bets.map((b) => {
    cumulative += pnlOf(b);
    return { placedAt: b.placedAt, cumulativePnl: round2(cumulative) };
  });
}

export interface BookBetsQuery extends BookScope {
  track?: string;
  betType?: string;
  result?: string;
  date?: string;
  limit?: number;
  offset?: number;
}

export function buildBookBets(opts: BookBetsQuery = {}) {
  let rows = scopedBets(opts);
  if (opts.track) rows = rows.filter((b) => b.track === opts.track);
  if (opts.betType) rows = rows.filter((b) => b.betType === opts.betType);
  if (opts.result) rows = rows.filter((b) => b.result === opts.result);
  if (opts.date) rows = rows.filter((b) => b.date === opts.date);
  // Most-recent first for the recent-bets table.
  rows = rows
    .slice()
    .sort((a, b) => (a.placedAt < b.placedAt ? 1 : a.placedAt > b.placedAt ? -1 : 0));
  const total = rows.length;
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const page = rows.slice(offset, offset + limit).map((b) => ({
    ...b,
    pnl: round2(pnlOf(b)),
    roi: roiPct(b.totalCost, b.payout),
  }));
  return { total, limit, offset, bets: page };
}
