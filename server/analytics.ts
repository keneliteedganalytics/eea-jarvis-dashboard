import { storage } from "./storage";
import type { CardWithRaces, RaceWithResult, Settings } from "@shared/schema";

function wagerForTier(tier: string, s: Settings): { stake: number; payoutMult: (winPayout: number | null) => number } {
  // stake = win-side stake; returns gross return if win pick won.
  switch (tier) {
    case "SNIPER":
      return { stake: s.sniperWin + s.sniperPlace, payoutMult: (wp) => (wp ? (s.sniperWin / 2) * wp : s.sniperWin * 2.5) };
    case "EDGE":
      return { stake: s.edgeWin + s.edgePlace, payoutMult: (wp) => (wp ? (s.edgeWin / 2) * wp : s.edgeWin * 2.3) };
    case "DUAL":
      return { stake: s.dualWin * 2, payoutMult: (wp) => (wp ? (s.dualWin / 2) * wp : s.dualWin * 2.2) };
    case "RECON":
      return { stake: s.reconWin, payoutMult: (wp) => (wp ? (s.reconWin / 2) * wp : s.reconWin * 2.0) };
    default:
      return { stake: 0, payoutMult: () => 0 };
  }
}

function classify(conditions: string | null): string {
  const c = (conditions || "").toLowerCase();
  if (c.includes("mdn")) return "Maiden";
  if (c.includes("(g") || c.includes("stakes") || c.includes(" s.")) return "Stakes";
  if (c.includes("clm")) return "OptClm";
  if (c.includes("alw")) return "Allowance";
  return "Other";
}

export function buildAnalyticsSummary() {
  const cards = storage.getCards();
  const settings = storage.getSettings();
  const fullCards: CardWithRaces[] = cards
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c);

  const allRaces: RaceWithResult[] = fullCards.flatMap((c) => c.races);
  const graded = allRaces.filter((r) => r.result);

  // Tier hit rates
  const tiers = ["SNIPER", "EDGE", "RECON", "PASS"];
  const tierHitRates = tiers.map((tier) => {
    const rs = graded.filter((r) => r.tier === tier);
    const n = rs.length || 1;
    const winN = rs.filter((r) => r.result?.winHit).length;
    const placeN = rs.filter((r) => r.result?.placeHit).length;
    const showN = rs.filter((r) => r.result?.showHit).length;
    const itm = rs.reduce((a, r) => a + (r.result?.itmCount ?? 0), 0);
    return {
      tier,
      win: rs.length ? Math.round((winN / n) * 100) : 0,
      place: rs.length ? Math.round((placeN / n) * 100) : 0,
      show: rs.length ? Math.round((showN / n) * 100) : 0,
      itm: rs.length ? Math.round((itm / (n * 4)) * 100) : 0,
    };
  });

  // Bankroll curve — cumulative net by race (graded, in race order across cards)
  let cumulative = 0;
  const bankrollCurve: { label: string; cumulative: number }[] = [{ label: "Start", cumulative: 0 }];
  let totalStaked = 0;
  let totalReturn = 0;
  for (const r of graded) {
    const { stake, payoutMult } = wagerForTier(r.tier, settings);
    totalStaked += stake;
    let ret = 0;
    if (r.result?.winHit) ret += payoutMult(r.result.winPayout ?? null);
    if (r.result?.placeHit && (r.tier === "SNIPER" || r.tier === "EDGE")) {
      const placeStake = r.tier === "SNIPER" ? settings.sniperPlace : settings.edgePlace;
      ret += r.result.placePayout ? (placeStake / 2) * r.result.placePayout : placeStake * 1.4;
    }
    totalReturn += ret;
    cumulative += ret - stake;
    bankrollCurve.push({ label: `R${r.raceNumber}`, cumulative: Math.round(cumulative) });
  }
  const roi = totalStaked > 0 ? Math.round(((totalReturn - totalStaked) / totalStaked) * 100) : 0;

  // Flag accuracy
  const flagMap = new Map<string, { hit: number; total: number }>();
  for (const r of allRaces) {
    const flags = JSON.parse(r.flags || "[]") as string[];
    const hitFlags: string[] = r.result ? (JSON.parse(r.result.flagsHit || "[]") as string[]) : [];
    for (const f of flags) {
      // Normalize flag family (strip the "on #N" suffix) for aggregation
      const fam = f.replace(/\s+on\s+#?\w+/i, "").replace(/\s+noted/i, "").trim().toUpperCase();
      const entry = flagMap.get(fam) ?? { hit: 0, total: 0 };
      if (r.result) {
        entry.total += 1;
        if (hitFlags.includes(f)) entry.hit += 1;
      }
      flagMap.set(fam, entry);
    }
  }
  const flagAccuracy = Array.from(flagMap.entries()).map(([flag, v]) => ({
    flag,
    pct: v.total ? Math.round((v.hit / v.total) * 100) : 0,
  }));

  // Race type performance
  const typeMap = new Map<string, { win: number; total: number }>();
  for (const r of graded) {
    const t = classify(r.conditions);
    const entry = typeMap.get(t) ?? { win: 0, total: 0 };
    entry.total += 1;
    if (r.result?.winHit) entry.win += 1;
    typeMap.set(t, entry);
  }
  const raceTypePerf = Array.from(typeMap.entries()).map(([type, v]) => ({
    type,
    winPct: v.total ? Math.round((v.win / v.total) * 100) : 0,
  }));

  // KPIs
  const winN = graded.filter((r) => r.result?.winHit).length;
  const avgWinPct = graded.length ? Math.round((winN / graded.length) * 100) : 0;
  const bestTier =
    tierHitRates.reduce((best, t) => (t.win > best.win ? t : best), { tier: "—", win: -1 }).tier;

  return {
    totalCards: cards.length,
    totalRaces: allRaces.length,
    gradedRaces: graded.length,
    avgWinPct,
    roi,
    bestTier,
    tierHitRates,
    bankrollCurve,
    flagAccuracy,
    raceTypePerf,
  };
}

// ── Lifetime scorecard (All-Time panel) ──────────────────────────────────
// Aggregates across EVERY card ever loaded — active AND archived — with no
// filter on cards.status. "Graded" mirrors the per-card panel's signal: a race
// is graded once a result has been logged for it.
export interface LifetimeTotals {
  cards: number;
  races: number;
  graded: number;
  win: number | null;
  place: number | null;
  show: number | null;
  fourth: number | null;
  exacta: number | null;
  tri: number | null;
  super: number | null;
  itm: number | null;
  flagAccuracy: number | null;
}
export interface LifetimeTrackRow {
  track: string;
  cards: number;
  races: number;
  graded: number;
  win: number | null;
  itm: number | null;
  lastUpdated: string | null;
}
export interface LifetimeStats {
  totals: LifetimeTotals;
  byTrack: LifetimeTrackRow[];
}

function pctOrNull(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Math.round((n / d) * 100);
}

export function buildLifetimeStats(): LifetimeStats {
  const allCards = storage.getCards();
  const fullCards: CardWithRaces[] = allCards
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c);

  const tally = (races: RaceWithResult[]) => {
    const graded = races.filter((r) => r.result);
    const g = graded.length;
    const winN = graded.filter((r) => r.result?.winHit).length;
    const placeN = graded.filter((r) => r.result?.placeHit).length;
    const showN = graded.filter((r) => r.result?.showHit).length;
    const fourthN = graded.filter((r) => r.result?.fourthHit).length;
    const exaN = graded.filter((r) => r.result?.exactaHit).length;
    const triN = graded.filter((r) => r.result?.trifectaHit).length;
    const supN = graded.filter((r) => r.result?.superfectaHit).length;
    const itmN = graded.filter((r) => (r.result?.itmCount ?? 0) > 0).length;
    let flagsRaised = 0;
    let flagsHit = 0;
    for (const r of graded) {
      const flags = JSON.parse(r.flags || "[]") as string[];
      flagsRaised += flags.length;
      const hit = JSON.parse(r.result?.flagsHit || "[]") as string[];
      flagsHit += hit.length;
    }
    return {
      races: races.length,
      graded: g,
      win: pctOrNull(winN, g),
      place: pctOrNull(placeN, g),
      show: pctOrNull(showN, g),
      fourth: pctOrNull(fourthN, g),
      exacta: pctOrNull(exaN, g),
      tri: pctOrNull(triN, g),
      super: pctOrNull(supN, g),
      itm: pctOrNull(itmN, g),
      flagAccuracy: pctOrNull(flagsHit, flagsRaised),
    };
  };

  const allRaces: RaceWithResult[] = fullCards.flatMap((c) => c.races);
  const overall = tally(allRaces);
  const totals: LifetimeTotals = {
    cards: fullCards.length,
    races: overall.races,
    graded: overall.graded,
    win: overall.win,
    place: overall.place,
    show: overall.show,
    fourth: overall.fourth,
    exacta: overall.exacta,
    tri: overall.tri,
    super: overall.super,
    itm: overall.itm,
    flagAccuracy: overall.flagAccuracy,
  };

  const byTrackMap = new Map<string, CardWithRaces[]>();
  for (const c of fullCards) {
    const list = byTrackMap.get(c.track) ?? [];
    list.push(c);
    byTrackMap.set(c.track, list);
  }
  const byTrack: LifetimeTrackRow[] = Array.from(byTrackMap.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((track) => {
      const trackCards = byTrackMap.get(track)!;
      const trackRaces = trackCards.flatMap((c) => c.races);
      const t = tally(trackRaces);
      const lastUpdated = trackCards
        .map((c) => c.date)
        .sort()
        .at(-1) ?? null;
      return {
        track,
        cards: trackCards.length,
        races: t.races,
        graded: t.graded,
        win: t.win,
        itm: t.itm,
        lastUpdated,
      };
    });

  return { totals, byTrack };
}

// ── Track-record hero summary ───────────────────────────────────────────────
// Units model (flat bet): every graded win-pick is a 1-unit win bet.
//   - win  → profit = (winPayout / 2) - 1   [payouts are quoted on a $2 base]
//            (falls back to +1.5u when the payout wasn't captured)
//   - loss → -1u
// ROI = net units / plays — a flat-bet ROI, intentionally simpler than the
// bankroll-weighted curve in buildAnalyticsSummary().
export type Timeframe = "7D" | "30D" | "90D" | "YTD" | "ALL";
export const TIMEFRAMES: Timeframe[] = ["7D", "30D", "90D", "YTD", "ALL"];

export interface TierRecord {
  tier: string;
  wins: number;
  plays: number;
  units: number;
}
export interface TrackRecordSummary {
  timeframe: Timeframe;
  wins: number;
  plays: number;
  winPct: number | null;
  units: number;
  roi: number | null;
  tiers: TierRecord[];
  generatedAt: string;
}

function timeframeCutoff(tf: Timeframe, now = new Date()): string | null {
  if (tf === "ALL") return null;
  if (tf === "YTD") return `${now.getUTCFullYear()}-01-01`;
  const days = tf === "7D" ? 7 : tf === "30D" ? 30 : 90;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function unitsForRace(r: RaceWithResult): number {
  if (!r.result) return 0;
  if (r.result.winHit) {
    const wp = r.result.winPayout;
    return wp && wp > 0 ? wp / 2 - 1 : 1.5;
  }
  return -1;
}

export function buildTrackRecordSummary(timeframe: Timeframe = "30D"): TrackRecordSummary {
  const cutoff = timeframeCutoff(timeframe);
  const cards = storage
    .getCards()
    .filter((c) => (cutoff ? c.date >= cutoff : true))
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c);

  const graded = cards.flatMap((c) => c.races).filter((r) => r.result);

  const plays = graded.length;
  const wins = graded.filter((r) => r.result?.winHit).length;
  const units = graded.reduce((a, r) => a + unitsForRace(r), 0);
  const winPct = plays > 0 ? Math.round((wins / plays) * 100) : null;
  const roi = plays > 0 ? Math.round((units / plays) * 1000) / 10 : null; // 1dp %

  const tiers: TierRecord[] = ["SNIPER", "EDGE", "DUAL"].map((tier) => {
    const rs = graded.filter((r) => r.tier === tier);
    return {
      tier,
      wins: rs.filter((r) => r.result?.winHit).length,
      plays: rs.length,
      units: Math.round(rs.reduce((a, r) => a + unitsForRace(r), 0) * 10) / 10,
    };
  });

  return {
    timeframe,
    wins,
    plays,
    winPct,
    units: Math.round(units * 10) / 10,
    roi,
    tiers,
    generatedAt: new Date().toISOString(),
  };
}

export function buildCardStats(card: CardWithRaces) {
  const graded = card.races.filter((r) => r.result);
  const winsHit = graded.filter((r) => r.result?.winHit).length;
  const itmHit = graded.filter((r) => (r.result?.itmCount ?? 0) > 0).length;
  const sniperRaces = card.races.filter((r) => r.tier === "SNIPER");
  const edgeRaces = card.races.filter((r) => r.tier === "EDGE");
  const sniperHits = sniperRaces.filter((r) => r.result?.winHit).length;
  const edgeHits = edgeRaces.filter((r) => r.result?.winHit).length;

  let flagsRaised = 0;
  let flagsHit = 0;
  for (const r of card.races) {
    const flags = JSON.parse(r.flags || "[]") as string[];
    flagsRaised += flags.length;
    if (r.result) {
      const hit = JSON.parse(r.result.flagsHit || "[]") as string[];
      flagsHit += hit.length;
    }
  }

  const summary = buildAnalyticsSummary();
  return {
    winsHit,
    itmHit,
    sniperHits,
    sniperCount: sniperRaces.length,
    edgeHits,
    edgeCount: edgeRaces.length,
    roi: summary.roi,
    flagsHit,
    flagsRaised,
  };
}
