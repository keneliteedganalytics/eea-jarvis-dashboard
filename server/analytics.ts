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

// Scope-aware summary. Default scope is "lifetime" so the existing
// no-argument callers keep their old behavior. Pass { scope: "today" } to
// filter to cards where card.date === today (UTC, matching how the rest of
// the codebase reckons "today"). Pass { scope: "track", track } to filter to
// one track all-time. An optional `date` further narrows scope="track" to a
// single day, which is how the single-card-today view drives this endpoint.
export interface AnalyticsScope {
  scope?: "today" | "track" | "lifetime";
  track?: string;
  date?: string; // YYYY-MM-DD
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildAnalyticsSummary(opts: AnalyticsScope = {}) {
  const scope = opts.scope ?? "lifetime";
  const cards = storage.getCards();
  const settings = storage.getSettings();
  const filteredCards = cards.filter((c) => {
    if (scope === "today") return c.date === todayUtc();
    if (scope === "track") {
      if (opts.track && c.track !== opts.track) return false;
      if (opts.date && c.date !== opts.date) return false;
      return !!opts.track;
    }
    return true;
  });
  const fullCards: CardWithRaces[] = filteredCards
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
  // PR #45: the headline ROI now reads from the bet_legs ledger (same source as
  // the bankroll pill and the Strategy ROI table) rather than the legacy
  // wagerForTier reconstruction, which over/under-stated dollars (Card #9 showed
  // +39.7% here while the bankroll ledger read +96%). Two sources of truth →
  // one. The wagerForTier path is retained only for the relative bankroll curve.
  const ledgerOverall = buildLedgerRoi(opts).overall;
  const roi = ledgerOverall.roi ?? 0;

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
  const itmN = graded.filter((r) => (r.result?.itmCount ?? 0) > 0).length;
  const avgItmPct = graded.length ? Math.round((itmN / graded.length) * 100) : 0;
  const bestTier =
    tierHitRates.reduce((best, t) => (t.win > best.win ? t : best), { tier: "—", win: -1 }).tier;

  return {
    scope,
    track: opts.track ?? null,
    date: opts.date ?? (scope === "today" ? todayUtc() : null),
    totalCards: fullCards.length,
    totalRaces: allRaces.length,
    gradedRaces: graded.length,
    avgWinPct,
    avgItmPct,
    roi,
    bestTier,
    tierHitRates,
    bankrollCurve,
    flagAccuracy,
    raceTypePerf,
  };
}

// Distinct-tracks list for the Per-Track scope chip strip. Ordered by
// lastDate desc so the most recently raced track surfaces first.
export interface AnalyticsTrackRow {
  track: string;
  cards: number;
  graded: number;
  lastDate: string | null;
}

export function buildAnalyticsTracks(): AnalyticsTrackRow[] {
  const cards = storage.getCards();
  const fullCards: CardWithRaces[] = cards
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c);
  const byTrack = new Map<string, CardWithRaces[]>();
  for (const c of fullCards) {
    const list = byTrack.get(c.track) ?? [];
    list.push(c);
    byTrack.set(c.track, list);
  }
  const rows: AnalyticsTrackRow[] = [];
  byTrack.forEach((list: CardWithRaces[], track: string) => {
    const graded = list.flatMap((c: CardWithRaces) => c.races).filter((r: RaceWithResult) => r.result).length;
    const lastDate = list.map((c: CardWithRaces) => c.date).sort().at(-1) ?? null;
    rows.push({ track, cards: list.length, graded, lastDate });
  });
  rows.sort((a, b) => {
    if (a.lastDate && b.lastDate) return b.lastDate.localeCompare(a.lastDate);
    if (a.lastDate) return -1;
    if (b.lastDate) return 1;
    return a.track.localeCompare(b.track);
  });
  return rows;
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

// ── Ledger ROI (PR #40) ───────────────────────────────────────────────────
// Aggregates the bet_legs ledger by tier, position (leg_type), tier×position,
// and flag. ROI% = (payout - cost) / cost. Only legs whose race has a known
// outcome (hit !== null) count toward ROI/hit-rate; ungraded legs are ignored.
// Scope-aware via the same card filter as buildAnalyticsSummary.
import type { BetLegRow } from "@shared/schema";

const LEG_POSITIONS = ["WIN", "PLACE", "SHOW", "EXACTA", "TRIFECTA", "SUPERFECTA"] as const;
const ROI_TIERS = ["SNIPER", "EDGE", "DUAL", "RECON"] as const;

export interface RoiRow {
  key: string;
  legs: number; // settled legs (hit !== null)
  cost: number;
  payout: number;
  roi: number | null; // percent, null when cost === 0
  hitRate: number | null; // percent of settled legs that hit
}

export interface LedgerRoi {
  scope: string;
  track: string | null;
  date: string | null;
  byTier: RoiRow[];
  byPosition: RoiRow[];
  matrix: { tier: string; position: string; roi: number | null; legs: number }[];
  byFlag: RoiRow[];
  overall: RoiRow;
}

function roiRow(key: string, legs: BetLegRow[]): RoiRow {
  const settled = legs.filter((l) => l.hit !== null);
  const cost = settled.reduce((a, l) => a + l.cost, 0);
  const payout = settled.reduce((a, l) => a + (l.payout ?? 0), 0);
  const hits = settled.filter((l) => l.hit === true).length;
  return {
    key,
    legs: settled.length,
    cost: Math.round(cost * 100) / 100,
    payout: Math.round(payout * 100) / 100,
    roi: cost > 0 ? Math.round(((payout - cost) / cost) * 1000) / 10 : null,
    hitRate: settled.length > 0 ? Math.round((hits / settled.length) * 100) : null,
  };
}

export function buildLedgerRoi(opts: AnalyticsScope = {}): LedgerRoi {
  const scope = opts.scope ?? "lifetime";
  const cards = storage.getCards().filter((c) => {
    if (scope === "today") return c.date === todayUtc();
    if (scope === "track") {
      if (opts.track && c.track !== opts.track) return false;
      if (opts.date && c.date !== opts.date) return false;
      return !!opts.track;
    }
    return true;
  });
  // Touch each card so the ledger is materialized (lazy persistence in storage).
  const cardIds = new Set<number>();
  for (const c of cards) {
    storage.getCardWithRaces(c.id);
    cardIds.add(c.id);
  }
  // PR #41: exclude refunded legs (scratched-out old picks). A refunded leg's
  // cost is removed from the ROI denominator entirely — it must never count as a
  // loss — so it is dropped before any bucketing.
  const legs = storage
    .getAllBetLegs()
    .filter((l) => cardIds.has(l.cardId) && !l.refunded);

  const byTier = ROI_TIERS.map((t) => roiRow(t, legs.filter((l) => l.tier === t)));
  const byPosition = LEG_POSITIONS.map((p) => roiRow(p, legs.filter((l) => l.legType === p)));

  const matrix: LedgerRoi["matrix"] = [];
  for (const t of ROI_TIERS) {
    for (const p of LEG_POSITIONS) {
      const cell = roiRow(`${t}|${p}`, legs.filter((l) => l.tier === t && l.legType === p));
      matrix.push({ tier: t, position: p, roi: cell.roi, legs: cell.legs });
    }
  }

  // Flag ROI: a leg's flags_json carries its race's flags. Normalize each flag
  // family (strip "on #N" suffix) and bucket every leg under each of its flags.
  const flagMap = new Map<string, BetLegRow[]>();
  for (const l of legs) {
    let flags: string[] = [];
    try {
      const j = JSON.parse(l.flagsJson || "[]");
      if (Array.isArray(j)) flags = j.map(String);
    } catch {
      flags = [];
    }
    for (const f of flags) {
      const fam = f.replace(/\s+on\s+#?\w+/i, "").replace(/\s+noted/i, "").trim().toUpperCase();
      if (!fam) continue;
      const list = flagMap.get(fam) ?? [];
      list.push(l);
      flagMap.set(fam, list);
    }
  }
  const byFlag = Array.from(flagMap.entries())
    .map(([flag, ls]) => roiRow(flag, ls))
    .sort((a, b) => (b.cost - a.cost));

  return {
    scope,
    track: opts.track ?? null,
    date: opts.date ?? (scope === "today" ? todayUtc() : null),
    byTier,
    byPosition,
    matrix,
    byFlag,
    overall: roiRow("ALL", legs),
  };
}

// ── PR #42 analytics tiles ────────────────────────────────────────────────
// Three new tiles, all scope-aware via the same card filter as the other
// analytics builders:
//   1. Tier Weight Performance — actual ledger ROI per tier vs the THEORETICAL
//      contribution (planned weight x hit rate), so we can see whether the
//      recalibrated weights are paying off.
//   2. Flag Performance — ROI when ml_favorite_matched fired, when a speed-gap
//      demotion fired, and when the Maiden Claim 9+ EX-only gate fired.
//   3. PASS-WIN MISSES — cards with PASS races whose winner was on our board.
import { isMaidenClaiming, DEFAULT_TIER_WEIGHTS } from "./services/budgeted-bets";
import type { CardSummaryRow, PassWinMissHorse } from "@shared/schema";

const PR42_TIERS = ["SNIPER", "EDGE", "DUAL", "RECON"] as const;

export interface TierWeightPerfRow {
  tier: string;
  plannedWeight: number; // from DEFAULT_TIER_WEIGHTS
  legs: number;
  cost: number;
  payout: number;
  actualRoi: number | null; // (payout - cost) / cost, %
  winRate: number | null; // % of graded WIN-pick races at this tier
  theoreticalContribution: number | null; // plannedWeight * winRate/100
}

export interface FlagPerfRow {
  flag: string; // ml_favorite_matched | speed_gap | field_size_maiden_claim_9plus
  legs: number;
  cost: number;
  payout: number;
  roi: number | null;
  hitRate: number | null;
}

export interface PassWinMissCard {
  cardId: number;
  track: string;
  date: string;
  count: number;
  horses: PassWinMissHorse[];
}

export interface Pr42Analytics {
  scope: string;
  track: string | null;
  date: string | null;
  tierWeightPerf: TierWeightPerfRow[];
  flagPerf: FlagPerfRow[];
  passWinMisses: PassWinMissCard[];
}

function scopeFilter(opts: AnalyticsScope, c: { track: string; date: string }): boolean {
  const scope = opts.scope ?? "lifetime";
  if (scope === "today") return c.date === todayUtc();
  if (scope === "track") {
    if (opts.track && c.track !== opts.track) return false;
    if (opts.date && c.date !== opts.date) return false;
    return !!opts.track;
  }
  return true;
}

export function buildPr42Analytics(opts: AnalyticsScope = {}): Pr42Analytics {
  const scope = opts.scope ?? "lifetime";
  const cards = storage.getCards().filter((c) => scopeFilter(opts, c));
  const fullCards: CardWithRaces[] = cards
    .map((c) => storage.getCardWithRaces(c.id))
    .filter((c): c is CardWithRaces => !!c);
  const cardIds = new Set(fullCards.map((c) => c.id));

  // Live (non-refunded) settled ledger legs in scope.
  const legs = storage
    .getAllBetLegs()
    .filter((l) => cardIds.has(l.cardId) && !l.refunded);
  const allRaces: RaceWithResult[] = fullCards.flatMap((c) => c.races);
  const graded = allRaces.filter((r) => r.result);

  // ── 1. Tier Weight Performance ──
  const tierWeightPerf: TierWeightPerfRow[] = PR42_TIERS.map((tier) => {
    const tLegs = legs.filter((l) => l.tier === tier && l.hit !== null);
    const cost = round2(tLegs.reduce((a, l) => a + l.cost, 0));
    const payout = round2(tLegs.reduce((a, l) => a + (l.payout ?? 0), 0));
    const actualRoi = cost > 0 ? round1(((payout - cost) / cost) * 100) : null;
    const tRaces = graded.filter((r) => r.tier === tier);
    const winN = tRaces.filter((r) => r.result?.winHit).length;
    const winRate = tRaces.length ? round1((winN / tRaces.length) * 100) : null;
    const plannedWeight = DEFAULT_TIER_WEIGHTS[tier];
    return {
      tier,
      plannedWeight,
      legs: tLegs.length,
      cost,
      payout,
      actualRoi,
      winRate,
      theoreticalContribution: winRate == null ? null : round1((plannedWeight * winRate) / 100),
    };
  });

  // ── 2. Flag Performance ──
  // ml_favorite_matched + speed_gap come off each leg's flags_json (the race's
  // flags, which carry the conviction-modifier markers fusion-v3 emits). The
  // field_size gate is reconstructed from each leg's race conditions + field
  // size, since gates ride on the leg object rather than flags_json.
  const flagMatch = (l: (typeof legs)[number], needle: RegExp): boolean => {
    try {
      const j = JSON.parse(l.flagsJson || "[]");
      return Array.isArray(j) && j.some((f) => needle.test(String(f)));
    } catch {
      return false;
    }
  };
  const raceById = new Map(allRaces.map((r) => [r.id, r]));
  const isGateLeg = (l: (typeof legs)[number]): boolean => {
    const r = raceById.get(l.raceId);
    if (!r) return false;
    return l.legType === "EXACTA" && isMaidenClaiming(r.conditions) && r.bets?.gates?.includes("field_size_maiden_claim_9plus") === true;
  };
  const flagPerf: FlagPerfRow[] = [
    flagPerfRow("ml_favorite_matched", legs.filter((l) => flagMatch(l, /ML_FAVORITE_MATCHED/i))),
    flagPerfRow("speed_gap", legs.filter((l) => flagMatch(l, /SPEED_GAP_DEMOTION/i))),
    flagPerfRow("field_size_maiden_claim_9plus", legs.filter(isGateLeg)),
  ];

  // ── 3. PASS-WIN MISSES ──
  const passWinMisses: PassWinMissCard[] = [];
  for (const c of fullCards) {
    const summary: CardSummaryRow | undefined = storage.getCardSummary(c.id);
    if (!summary || (summary.passWinMissCount ?? 0) === 0) continue;
    let horses: PassWinMissHorse[] = [];
    try {
      const j = JSON.parse(summary.passWinMissHorses || "[]");
      if (Array.isArray(j)) horses = j as PassWinMissHorse[];
    } catch {
      horses = [];
    }
    passWinMisses.push({
      cardId: c.id,
      track: c.track,
      date: c.date,
      count: summary.passWinMissCount,
      horses,
    });
  }
  passWinMisses.sort((a, b) => b.date.localeCompare(a.date));

  return {
    scope,
    track: opts.track ?? null,
    date: opts.date ?? (scope === "today" ? todayUtc() : null),
    tierWeightPerf,
    flagPerf,
    passWinMisses,
  };
}

function flagPerfRow(flag: string, ls: { hit: boolean | null; cost: number; payout: number | null }[]): FlagPerfRow {
  const settled = ls.filter((l) => l.hit !== null);
  const cost = round2(settled.reduce((a, l) => a + l.cost, 0));
  const payout = round2(settled.reduce((a, l) => a + (l.payout ?? 0), 0));
  const hits = settled.filter((l) => l.hit === true).length;
  return {
    flag,
    legs: settled.length,
    cost,
    payout,
    roi: cost > 0 ? round1(((payout - cost) / cost) * 100) : null,
    hitRate: settled.length ? Math.round((hits / settled.length) * 100) : null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
