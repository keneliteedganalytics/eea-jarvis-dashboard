// Expert Picks Comparison — ingestion, reconciliation, and read endpoints, plus
// the EEA-vs-expert comparison builder used by the analytics header.
//
// Endpoints (all under /api):
//   POST /api/expert-picks/fetch      admin-gated — run the scrapers + upsert
//   POST /api/expert-picks/reconcile  admin-gated — grade rows once a race is official
//   GET  /api/expert-picks            open — read picks by track/date/source
//   GET  /api/analytics/expert-comparison  open — EEA vs expert head-to-head
//
// The two POSTs inherit the global adminPinGate (x-admin-pin) in routes.ts since
// every mutating /api route is gated there.

import type { Express } from "express";
import { storage } from "./storage";
import {
  expertPicksFetchSchema,
  expertPicksReconcileSchema,
} from "@shared/schema";
import type { ExpertPickRow, RealBetRow } from "@shared/schema";
import { fetchAllExpertPicks } from "./expert-picks-fetchers";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Today in America/Boise (Ken's operating timezone), as YYYY-MM-DD.
export function todayInBoise(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

// Grade a single expert pick against the actual winner. WIN if the top pick won;
// PLACE/SHOW/4TH if the winner appears as the 1st/2nd/3rd backup; else OUT.
export function gradeExpertPick(
  row: { topPick: number; picks24: number[] },
  winner: number,
): "WIN" | "PLACE" | "SHOW" | "4TH" | "OUT" {
  if (row.topPick === winner) return "WIN";
  const backups = row.picks24;
  if (backups[0] === winner) return "PLACE";
  if (backups[1] === winner) return "SHOW";
  if (backups[2] === winner) return "4TH";
  return "OUT";
}

// Parse the stored picks_2_4 JSON string into a number[] defensively.
function parsePicks24(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((n) => Number(n)).filter((n) => !Number.isNaN(n)) : [];
  } catch {
    return [];
  }
}

// "In the money" for an expert row = top pick or a backup hit (anything but OUT).
const ITM_RESULTS = new Set(["WIN", "PLACE", "SHOW", "4TH"]);

interface ComparisonOpts {
  track?: string; // "ALL" or a display track name
  date?: string;
  from?: string;
  to?: string;
}

function realBetInScope(b: RealBetRow, o: ComparisonOpts): boolean {
  if (o.date && b.date !== o.date) return false;
  if (o.from && b.date < o.from) return false;
  if (o.to && b.date > o.to) return false;
  if (o.track && o.track !== "ALL" && b.track !== o.track) return false;
  return true;
}

function expertInScope(p: ExpertPickRow, o: ComparisonOpts): boolean {
  if (o.date && p.date !== o.date) return false;
  if (o.from && p.date < o.from) return false;
  if (o.to && p.date > o.to) return false;
  if (o.track && o.track !== "ALL" && p.track !== o.track) return false;
  return true;
}

// Flat-bet ROI sim for the expert side. TODO: plug in real win odds once the
// expert tables carry them; for now assume a flat $2 stake returning an average
// $7 on a win (a ~2.5-1 winner), which keeps the comparison directionally honest.
const FLAT_STAKE = 2;
const AVG_WIN_PAYOUT = 7;

export function buildExpertComparison(opts: ComparisonOpts = {}) {
  const eeaBets = storage.getAllRealBets().filter((b) => realBetInScope(b, opts));
  const eeaWagered = round2(eeaBets.reduce((s, b) => s + b.totalCost, 0));
  const eeaPayout = round2(eeaBets.reduce((s, b) => s + b.payout, 0));
  const eeaWins = eeaBets.filter((b) => b.result === "WIN").length;
  const eeaItm = eeaBets.filter((b) =>
    ["WIN", "PLACE", "SHOW"].includes(b.result),
  ).length;
  const eeaNet = round2(eeaPayout - eeaWagered);
  const eeaRoi = eeaWagered > 0 ? round1((eeaNet / eeaWagered) * 100) : 0;
  const eeaWinPct = eeaBets.length > 0 ? round1((eeaWins / eeaBets.length) * 100) : 0;

  const expertRows = storage
    .getExpertPicks(
      opts.track && opts.track !== "ALL"
        ? { track: opts.track, date: opts.date }
        : opts.date
          ? { date: opts.date }
          : undefined,
    )
    .filter((p) => expertInScope(p, opts));

  // Only graded rows (result set) count toward win/itm tallies.
  const graded = expertRows.filter((p) => p.result != null);
  const expertWins = graded.filter((p) => p.result === "WIN").length;
  const expertItm = graded.filter((p) => ITM_RESULTS.has(p.result ?? "")).length;
  const racesPicked = expertRows.length;
  const expertWinPct = graded.length > 0 ? round1((expertWins / graded.length) * 100) : 0;
  const expertItmPct = graded.length > 0 ? round1((expertItm / graded.length) * 100) : 0;

  const flatWagered = graded.length * FLAT_STAKE;
  const flatReturn = expertWins * AVG_WIN_PAYOUT;
  const flatBetRoi =
    flatWagered > 0 ? round1(((flatReturn - flatWagered) / flatWagered) * 100) : 0;

  // The expert source label: collapse to the distinct handicappers present.
  const sources = Array.from(
    new Set(expertRows.map((p) => p.sourceHandicapper)),
  ).sort();

  return {
    eea: {
      bets: eeaBets.length,
      wins: eeaWins,
      itm: eeaItm,
      wagered: eeaWagered,
      payout: eeaPayout,
      net: eeaNet,
      roi: eeaRoi,
      winPct: eeaWinPct,
    },
    expert: {
      source: sources.join(", "),
      sources,
      races_picked: racesPicked,
      graded: graded.length,
      wins: expertWins,
      itm: expertItm,
      win_pct: expertWinPct,
      itm_pct: expertItmPct,
      flat_bet_roi: flatBetRoi,
    },
    edge: {
      win_pct_delta: round1(eeaWinPct - expertWinPct),
      roi_delta: round1(eeaRoi - flatBetRoi),
    },
  };
}

export function registerExpertPicksRoutes(app: Express): void {
  // Run the scrapers and bulk-upsert. Admin-gated (POST). Body { date, tracks }.
  app.post("/api/expert-picks/fetch", async (req, res) => {
    const parsed = expertPicksFetchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid body", details: parsed.error.flatten() });
    }
    try {
      const { success, failures } = await fetchAllExpertPicks(
        parsed.data.date,
        parsed.data.tracks,
      );
      const upsert = storage.bulkUpsertExpertPicks(success);
      res.json({
        fetched: success.length,
        inserted: upsert.inserted,
        updated: upsert.updated,
        failures,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Grade every expert row for a (track, date, race) against the actual winner.
  // Admin-gated (POST). Body { date, track, race, winner }.
  app.post("/api/expert-picks/reconcile", (req, res) => {
    const parsed = expertPicksReconcileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "invalid body", details: parsed.error.flatten() });
    }
    const { date, track, race, winner } = parsed.data;
    const rows = storage
      .getExpertPicks({ track, date })
      .filter((p) => p.race === race);
    let graded = 0;
    for (const row of rows) {
      const result = gradeExpertPick(
        { topPick: row.topPick, picks24: parsePicks24(row.picks24) },
        winner,
      );
      storage.updateExpertPickResult(row.id, result, winner);
      graded++;
    }
    res.json({ graded, winner });
  });

  // Read picks. Open (GET). Query: track, date, source.
  app.get("/api/expert-picks", (req, res) => {
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    res.json(storage.getExpertPicks({ track, date, source }));
  });

  // EEA vs expert head-to-head. Open (GET). Query: track (default ALL),
  // date (default today/Boise), from, to.
  app.get("/api/analytics/expert-comparison", (req, res) => {
    const track = typeof req.query.track === "string" ? req.query.track : "ALL";
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    // date defaults to today (Boise) only when no explicit range is given.
    let date: string | undefined;
    if (typeof req.query.date === "string") date = req.query.date;
    else if (!from && !to) date = todayInBoise();
    res.json(buildExpertComparison({ track, date, from, to }));
  });
}
