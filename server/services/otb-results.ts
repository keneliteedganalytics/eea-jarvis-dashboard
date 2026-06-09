// OffTrackBetting full-card results parser (PR #44).
//
// The Equibase auto-fetch (poller.ts) is the card's primary result source, but
// it lags on smaller tracks (notably Finger Lakes). OTB publishes a public,
// structured results page per track per day:
//
//   https://www.offtrackbetting.com/results/{track-slug}/YYYY-MM-DD.html
//
// This module fetches + parses that page into a typed per-race view the
// auto-grader (results-poller-cron.ts) and the per-race "Refresh from OTB"
// button upsert into `results`. It is distinct from otb-finger-lakes.ts, which
// is a FL-only scratch/fallback source on a different (numeric-id) URL.
//
// Resilience contract: a fetch/parse failure NEVER throws. fetchOtbResults()
// resolves to null so callers degrade silently. A 5-minute in-memory cache
// (keyed by slug+date) keeps the 5-min cron + manual buttons from hammering OTB.

import * as cheerio from "cheerio";

// Real Chrome UA + Accept headers. Server-side fetches with our own UA string
// returned a bot-detection stub from OTB on the live day; these headers get the
// same HTML a browser sees. (PR #45)
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const CACHE_TTL_MS = 5 * 60 * 1000;

// Explicit track-name → OTB slug map. Case-insensitive lookup (keys are lower).
// Anything not listed falls back to slugify(). Extend as new tracks appear.
const TRACK_SLUGS: Record<string, string> = {
  "finger lakes": "finger-lakes",
  "saratoga": "saratoga",
  "belmont": "belmont-park",
  "belmont park": "belmont-park",
  "aqueduct": "aqueduct",
  "churchill downs": "churchill-downs",
  "gulfstream": "gulfstream-park",
  "gulfstream park": "gulfstream-park",
  "santa anita": "santa-anita",
  "tampa bay downs": "tampa-bay-downs",
  "oaklawn": "oaklawn-park",
  "oaklawn park": "oaklawn-park",
  "keeneland": "keeneland",
  "del mar": "del-mar",
};

// Lowercase, trim, collapse whitespace runs to single dashes, drop anything that
// isn't a-z/0-9/dash. Mirrors OTB's own slug shape for tracks not in the map.
export function slugify(track: string): string {
  return track
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function trackSlug(track: string): string {
  const key = track.trim().toLowerCase();
  return TRACK_SLUGS[key] ?? slugify(track);
}

// OTB's stable numeric track IDs, keyed by slug. The live/current-day results
// page is served at /results/{trackId}/{slug}.html — the date-pattern URL
// returns a stub for TODAY (confirmed FL=30 on 2026-06-09). Historical dates
// still use the date-pattern URL. Verified entries are marked; unverified ones
// fall back to the date URL automatically when absent. (PR #45)
const TRACK_IDS: Record<string, number> = {
  "finger-lakes": 30, // verified live 2026-06-09
  "churchill-downs": 22,
  "gulfstream-park": 36,
  "santa-anita": 71,
  "tampa-bay-downs": 81,
  "oaklawn-park": 60,
  "keeneland": 44,
  "del-mar": 26,
};

function todayYMD(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// Live/current day → track-id URL (the one OTB actually serves with live
// results). Falls back to the date-pattern URL when the track has no known id
// or for any historical date.
export function otbResultsUrl(track: string, dateYMD: string, now: number = Date.now()): string {
  const slug = trackSlug(track);
  if (dateYMD === todayYMD(now)) {
    const tid = TRACK_IDS[slug];
    if (tid) return `https://www.offtrackbetting.com/results/${tid}/${slug}.html`;
  }
  return `https://www.offtrackbetting.com/results/${slug}/${dateYMD}.html`;
}

export interface OtbFinisher {
  pgm: string;
  horse: string;
  jockey: string;
}

export interface OtbRaceResult {
  raceNumber: number;
  scheduledPost: string; // "12:30 PM" (best-effort; "" if absent)
  finishOrder: string[]; // program numbers 1st..nth (for grading)
  finishers: OtbFinisher[]; // 1st..4th detail
  winPgm?: string;
  placePgm?: string;
  showPgm?: string;
  fourthPgm?: string;
  winPayout?: number; // top finisher's $2 win payout
  placePayout?: number; // top finisher's $2 place payout
  showPayout?: number; // top finisher's $2 show payout
  exactaPayout?: number;
  exactaCombo?: string;
  trifectaPayout?: number;
  trifectaCombo?: string;
  superfectaPayout?: number;
  superfectaCombo?: string;
  dailyDoublePayout?: number;
  dailyDoubleCombo?: string;
  pick3Payout?: number;
  pick3Combo?: string;
  pick4Payout?: number;
  pick4Combo?: string;
  pick5Payout?: number;
  pick5Combo?: string;
  payoutsRaw: Record<string, unknown>; // full structured payload
  isOfficial: boolean; // false when the page shows "No results for Race N yet"
}

export interface OtbCardResult {
  track: string;
  date: string;
  races: OtbRaceResult[];
  fetchedAt: string;
}

// Strip "$", commas, whitespace → finite number or undefined.
function money(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function intOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

const NO_RESULT_RE = /no results? for/i;

// Parse the OTB results HTML into the typed card view. Pure + synchronous so the
// fixture test drives it without a network round-trip. Returns null only on a
// thrown parse error (callers treat null as "no OTB data").
export function parseOtbResults(
  html: string,
  track: string,
  dateYMD: string,
  fetchedAt: string,
): OtbCardResult | null {
  try {
    const $ = cheerio.load(html);

    // Index payouts + finishers by race number so we can merge them per race.
    const finishersByRace = new Map<number, OtbFinisher[]>();
    $(".results-race, [data-section='results'] .race-block").each((_, el) => {
      const $el = $(el);
      const race = intOrNull(
        $el.attr("data-race") || $el.find(".race-number").first().text() || "",
      );
      if (race == null) return;
      const blockText = $el.text();
      // Sentinel: page placeholder for an un-run / not-yet-official race.
      if (NO_RESULT_RE.test(blockText) && $el.find(".finisher").length === 0) {
        finishersByRace.set(race, []); // mark seen-but-empty
        return;
      }
      const finishers: OtbFinisher[] = [];
      $el.find(".finisher, tr.finisher").each((i, f) => {
        const $f = $(f);
        const pgm = ($f.find(".program, .pgm").first().text() || "").trim();
        const horse = ($f.find(".horse, .name").first().text() || "").trim();
        const jockey = ($f.find(".jockey, .jky").first().text() || "").trim();
        if (pgm && horse) finishers.push({ pgm, horse, jockey });
      });
      finishersByRace.set(race, finishers);
    });

    interface PayoutBlock {
      win?: number;
      place?: number;
      show?: number;
      exactaPayout?: number;
      exactaCombo?: string;
      trifectaPayout?: number;
      trifectaCombo?: string;
      superfectaPayout?: number;
      superfectaCombo?: string;
      dailyDoublePayout?: number;
      dailyDoubleCombo?: string;
      pick3Payout?: number;
      pick3Combo?: string;
      pick4Payout?: number;
      pick4Combo?: string;
      pick5Payout?: number;
      pick5Combo?: string;
      post?: string;
    }
    const payoutsByRace = new Map<number, PayoutBlock>();
    $(".payouts-race, [data-section='payouts'] .race-block").each((_, el) => {
      const $el = $(el);
      const race = intOrNull(
        $el.attr("data-race") || $el.find(".race-number").first().text() || "",
      );
      if (race == null) return;
      const exotic = (sel: string) => {
        const t = $el.find(sel).first();
        const payout = money(t.find(".payout, .amount").first().text() || t.text());
        const combo = (t.find(".combo").first().text() || "").trim() || undefined;
        return { payout, combo };
      };
      const ex = exotic(".exacta, .ex");
      const tri = exotic(".trifecta, .tri");
      const sup = exotic(".superfecta, .super, .sup");
      const dd = exotic(".daily-double, .dd, .double");
      const p3 = exotic(".pick3, .pick-3");
      const p4 = exotic(".pick4, .pick-4");
      const p5 = exotic(".pick5, .pick-5");
      payoutsByRace.set(race, {
        win: money($el.find(".win").first().text()),
        place: money($el.find(".place").first().text()),
        show: money($el.find(".show").first().text()),
        exactaPayout: ex.payout,
        exactaCombo: ex.combo,
        trifectaPayout: tri.payout,
        trifectaCombo: tri.combo,
        superfectaPayout: sup.payout,
        superfectaCombo: sup.combo,
        dailyDoublePayout: dd.payout,
        dailyDoubleCombo: dd.combo,
        pick3Payout: p3.payout,
        pick3Combo: p3.combo,
        pick4Payout: p4.payout,
        pick4Combo: p4.combo,
        pick5Payout: p5.payout,
        pick5Combo: p5.combo,
        post: ($el.find(".post, .post-time").first().text() || "").trim() || undefined,
      });
    });

    const raceNumbers = new Set<number>([
      ...Array.from(finishersByRace.keys()),
      ...Array.from(payoutsByRace.keys()),
    ]);

    const races: OtbRaceResult[] = [];
    for (const raceNumber of Array.from(raceNumbers).sort((a, b) => a - b)) {
      const finishers = finishersByRace.get(raceNumber) ?? [];
      const p = payoutsByRace.get(raceNumber) ?? {};
      const isOfficial = finishers.length > 0;
      const finishOrder = finishers.map((f) => f.pgm);
      races.push({
        raceNumber,
        scheduledPost: p.post ?? "",
        finishOrder,
        finishers: finishers.slice(0, 4),
        winPgm: finishers[0]?.pgm,
        placePgm: finishers[1]?.pgm,
        showPgm: finishers[2]?.pgm,
        fourthPgm: finishers[3]?.pgm,
        winPayout: p.win,
        placePayout: p.place,
        showPayout: p.show,
        exactaPayout: p.exactaPayout,
        exactaCombo: p.exactaCombo,
        trifectaPayout: p.trifectaPayout,
        trifectaCombo: p.trifectaCombo,
        superfectaPayout: p.superfectaPayout,
        superfectaCombo: p.superfectaCombo,
        dailyDoublePayout: p.dailyDoublePayout,
        dailyDoubleCombo: p.dailyDoubleCombo,
        pick3Payout: p.pick3Payout,
        pick3Combo: p.pick3Combo,
        pick4Payout: p.pick4Payout,
        pick4Combo: p.pick4Combo,
        pick5Payout: p.pick5Payout,
        pick5Combo: p.pick5Combo,
        payoutsRaw: { finishers, payouts: p },
        isOfficial,
      });
    }

    return { track, date: dateYMD, races, fetchedAt };
  } catch (e) {
    console.warn(`[otb-results] parse failed: ${(e as Error).message}`);
    return null;
  }
}

const cache = new Map<string, { data: OtbCardResult; at: number }>();

// Fetch + parse a track's OTB results page for a date, with a 5-minute cache.
// Never throws: on network/parse failure it logs a warning and returns null.
export async function fetchOtbResults(
  track: string,
  dateYMD: string,
  now: number = Date.now(),
): Promise<OtbCardResult | null> {
  const url = otbResultsUrl(track, dateYMD, now);
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;

  const html = await fetchOtbHtml(url);
  if (html == null) return null;
  const data = parseOtbResults(html, track, dateYMD, new Date(now).toISOString());
  if (!data) return null;
  cache.set(url, { data, at: now });
  return data;
}

// Fetch the raw OTB HTML for a URL. Tries a plain (browser-header) fetch first;
// if OTB_USE_PLAYWRIGHT=1 is set it routes through the Playwright browser-session
// infra (PR #29) instead — same path Equibase/Brisnet use to beat bot detection.
// Returns null (never throws) on any failure so callers degrade silently.
async function fetchOtbHtml(url: string): Promise<string | null> {
  if (process.env.OTB_USE_PLAYWRIGHT === "1") {
    return fetchOtbHtmlViaPlaywright(url);
  }
  try {
    const resp = await fetch(url, { headers: BROWSER_HEADERS });
    if (!resp.ok) {
      console.warn(`[otb-results] ${url} returned ${resp.status}`);
      return null;
    }
    return await resp.text();
  } catch (e) {
    console.warn(`[otb-results] fetch failed for ${url}: ${(e as Error).message}`);
    return null;
  }
}

// Playwright fallback for when the plain fetch keeps getting a bot stub. Lazily
// imports playwright so the module has no hard dep when the flag is off (and the
// dep is dev-only on some hosts). Loads the page with the same Chrome UA and
// returns the rendered HTML.
async function fetchOtbHtmlViaPlaywright(url: string): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try {
      const ctx = await browser.newContext({ userAgent: BROWSER_HEADERS["User-Agent"] });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return await page.content();
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.warn(`[otb-results] playwright fetch failed for ${url}: ${(e as Error).message}`);
    return null;
  }
}

// Test/clear hook so unit tests don't bleed cache between cases.
export function __clearOtbResultsCache(): void {
  cache.clear();
}
