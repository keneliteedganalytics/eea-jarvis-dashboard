// OffTrackBetting Finger Lakes fallback source (PR #23).
//
// The Equibase + Brisnet ingest is the card's source-of-record, but its
// scratch feed for Finger Lakes occasionally lags the morning line. OTB
// publishes a public results/scratches page that is often fresher. We scrape it
// with cheerio (already a dep from the Brisnet ingest), expose a typed view, and
// use it ONLY as a fallback (see scratch-refresh-cron.ts). The page is public —
// no credentials — but we identify ourselves with a descriptive User-Agent.
//
// Resilience contract: a parse/fetch failure NEVER throws. fetchOtbFingerLakes()
// resolves to null so the caller (a graceful fallback) degrades silently. A
// 5-minute in-memory cache keeps repeated voice queries + the 15-min cron from
// hammering OTB.

import * as cheerio from "cheerio";

export const OTB_FINGER_LAKES_URL =
  "https://www.offtrackbetting.com/results/30/finger-lakes.html";

const USER_AGENT =
  "EEA-Jarvis-Dashboard/1.0 (contact ken@elite-edge-analytics.com)";

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface OtbScratch {
  race: number;
  program: string;
  horse: string;
}

export interface OtbConditions {
  surface: string;
  condition: string;
  notes?: string;
}

export interface OtbFinisher {
  pos: number;
  program: string;
  horse: string;
}

export interface OtbResult {
  race: number;
  finishers: OtbFinisher[];
}

export interface OtbPayout {
  race: number;
  win?: number;
  place?: number;
  show?: number;
}

export interface OtbPurse {
  race: number;
  purse: number;
}

export interface OtbFingerLakesData {
  date: string; // ISO date parsed from the page header (best-effort)
  scratches: OtbScratch[];
  conditions: OtbConditions | null;
  results: OtbResult[];
  payouts: OtbPayout[];
  purses: OtbPurse[];
  fetchedAt: string; // ISO timestamp of this fetch
}

let cache: { data: OtbFingerLakesData; at: number } | null = null;

// Strip "$", commas, and stray whitespace, returning a finite number or
// undefined. Used for payouts ("$8.40") and purses ("$11,000").
function money(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function intOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Parse the OTB Finger Lakes HTML into the typed view. Pure + synchronous so the
// fixture test can drive it without a network round-trip. Returns null only on a
// thrown parse error (callers treat null as "no OTB data").
export function parseOtbFingerLakes(html: string, fetchedAt: string): OtbFingerLakesData | null {
  try {
    const $ = cheerio.load(html);

    // Date: a header element carrying data-date or an ISO-ish string.
    let date = $("[data-race-date]").first().attr("data-race-date") || "";
    if (!date) {
      const headerText = $(".results-header, h1, h2").first().text();
      const m = headerText.match(/(\d{4}-\d{2}-\d{2})/);
      date = m?.[1] ?? "";
    }

    // Scratches: rows under a scratches section. Each row carries race #, the
    // program (saddlecloth) number, and the horse name.
    const scratches: OtbScratch[] = [];
    $(".scratches .scratch-row, [data-section='scratches'] tr").each((_, el) => {
      const $el = $(el);
      const race = intOrNull($el.find(".race, [data-race]").first().text() || $el.attr("data-race") || "");
      const program = ($el.find(".program, .pgm").first().text() || "").trim();
      const horse = ($el.find(".horse, .name").first().text() || "").trim();
      if (race != null && program && horse) {
        scratches.push({ race, program, horse });
      }
    });

    // Conditions: a single block with surface + condition (+ optional notes).
    let conditions: OtbConditions | null = null;
    const condEl = $(".conditions, [data-section='conditions']").first();
    if (condEl.length) {
      const surface = (condEl.find(".surface").first().text() || "").trim();
      const condition = (condEl.find(".condition").first().text() || "").trim();
      const notes = (condEl.find(".notes").first().text() || "").trim();
      if (surface || condition) {
        conditions = { surface, condition, ...(notes ? { notes } : {}) };
      }
    }

    // Results: per-race finishing order.
    const results: OtbResult[] = [];
    $(".results-race, [data-section='results'] .race-block").each((_, el) => {
      const $el = $(el);
      const race = intOrNull($el.attr("data-race") || $el.find(".race-number").first().text() || "");
      if (race == null) return;
      const finishers: OtbFinisher[] = [];
      $el.find(".finisher, tr.finisher").each((i, f) => {
        const $f = $(f);
        const pos = intOrNull($f.find(".pos, .finish").first().text() || "") ?? i + 1;
        const program = ($f.find(".program, .pgm").first().text() || "").trim();
        const horse = ($f.find(".horse, .name").first().text() || "").trim();
        if (program && horse) finishers.push({ pos, program, horse });
      });
      if (finishers.length) results.push({ race, finishers });
    });

    // Payouts: per-race win/place/show.
    const payouts: OtbPayout[] = [];
    $(".payouts-race, [data-section='payouts'] .race-block").each((_, el) => {
      const $el = $(el);
      const race = intOrNull($el.attr("data-race") || $el.find(".race-number").first().text() || "");
      if (race == null) return;
      payouts.push({
        race,
        win: money($el.find(".win").first().text()),
        place: money($el.find(".place").first().text()),
        show: money($el.find(".show").first().text()),
      });
    });

    // Purses: per-race purse $.
    const purses: OtbPurse[] = [];
    $(".purses-race, [data-section='purses'] .race-block").each((_, el) => {
      const $el = $(el);
      const race = intOrNull($el.attr("data-race") || $el.find(".race-number").first().text() || "");
      const purse = money($el.find(".purse").first().text());
      if (race != null && purse != null) purses.push({ race, purse });
    });

    return { date, scratches, conditions, results, payouts, purses, fetchedAt };
  } catch (e) {
    console.warn(`[otb-finger-lakes] parse failed: ${(e as Error).message}`);
    return null;
  }
}

// Fetch + parse the live OTB Finger Lakes page, with a 5-minute in-memory cache.
// Never throws: on network/parse failure it logs a warning and returns null.
export async function fetchOtbFingerLakes(now: number = Date.now()): Promise<OtbFingerLakesData | null> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;

  try {
    const resp = await fetch(OTB_FINGER_LAKES_URL, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!resp.ok) {
      console.warn(`[otb-finger-lakes] fetch returned ${resp.status}`);
      return null;
    }
    const html = await resp.text();
    const data = parseOtbFingerLakes(html, new Date(now).toISOString());
    if (!data) return null;
    cache = { data, at: now };
    return data;
  } catch (e) {
    console.warn(`[otb-finger-lakes] fetch failed: ${(e as Error).message}`);
    return null;
  }
}

// Test/clear hook so unit tests don't bleed cache between cases.
export function __clearOtbCache(): void {
  cache = null;
}
