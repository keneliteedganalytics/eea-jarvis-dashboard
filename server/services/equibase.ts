// Race-result auto-fetcher.
//
// Source: HorseRacingNation (HRN) — https://entries.horseracingnation.com
// URL pattern: /entries-results/{track-slug}/{YYYY-MM-DD}
//
// HRN exposes clean payout tables per race:
//   - <a class="race-header" id="race-N"> anchors each race
//   - <table class="table-payouts"> = Win/Place/Show by program number
//   - <table class="table-exotic-payouts"> = Exacta / Trifecta / Superfecta with finish order
//
// The exported symbol name `fetchEquibaseResult` is preserved to avoid churn in
// poller.ts (which imports it). The implementation now hits HRN, not Equibase.

import * as cheerio from "cheerio";

export interface EquibaseRaceResult {
  finishOrder: string[];
  winPayout: number;
  placePayout: number;
  showPayout: number;
  exactaPayout?: number;
  trifectaPayout?: number;
  superfectaPayout?: number;
}

// Kept for any legacy reference; not used by the HRN parser.
export const TRACK_CODES: Record<string, string> = {
  Saratoga: "SAR",
  Belmont: "BEL",
  "Belmont at the Big A": "BAQ",
  Aqueduct: "AQU",
  "Churchill Downs": "CD",
  "Gulfstream Park": "GP",
  "Santa Anita": "SA",
  "Del Mar": "DMR",
  Keeneland: "KEE",
  Oaklawn: "OP",
};

// Track name -> HRN URL slug.
export const TRACK_SLUGS: Record<string, string> = {
  Saratoga: "saratoga",
  Belmont: "belmont",
  "Belmont at the Big A": "aqueduct",
  Aqueduct: "aqueduct",
  "Churchill Downs": "churchill-downs",
  "Gulfstream Park": "gulfstream-park",
  "Santa Anita": "santa-anita",
  "Del Mar": "del-mar",
  Keeneland: "keeneland",
  Oaklawn: "oaklawn-park",
  "Oaklawn Park": "oaklawn-park",
};

export function hrnUrlFor(track: string, date: string): string | null {
  const slug = TRACK_SLUGS[track];
  if (!slug) return null;
  return `https://entries.horseracingnation.com/entries-results/${slug}/${date}`;
}

// Back-compat: the old equibase summary URL helper. Returns the HRN URL now
// (the function name is referenced from no other module, but kept for safety).
export function summaryUrlFor(track: string, date: string): string | null {
  return hrnUrlFor(track, date);
}

export async function fetchEquibaseResult(
  track: string,
  date: string,
  raceNumber: number,
): Promise<EquibaseRaceResult | null> {
  const url = hrnUrlFor(track, date);
  if (!url) {
    console.warn(`[hrn] no slug for track "${track}"`);
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard",
      },
    });
    if (!response.ok) {
      console.warn(`[hrn] HTTP ${response.status} for ${url}`);
      return null;
    }
    const html = await response.text();
    return parseHrnResults(html, raceNumber);
  } catch (err) {
    console.error("[hrn] fetch failed:", err);
    return null;
  }
}

// Parse a money string like "$6.82" -> 6.82, "$2,542.20" -> 2542.20, "-" -> 0.
function parseMoney(raw: string | undefined | null): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned || cleaned === "-") return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function tidy(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export function parseHrnResults(
  html: string,
  raceNumber: number,
): EquibaseRaceResult | null {
  const $ = cheerio.load(html);

  // Locate this race's section by id="race-N".
  const anchor = $(`a.race-header#race-${raceNumber}`);
  if (anchor.length === 0) return null;

  // The payout tables are siblings further down in the DOM. The simplest reliable
  // approach: slice the raw HTML between this anchor and the next race anchor,
  // then re-parse that slice. This guarantees we only see this race's tables.
  const fullHtml = html;
  const startMarker = `id="race-${raceNumber}"`;
  const endMarker = `id="race-${raceNumber + 1}"`;
  const startIdx = fullHtml.indexOf(startMarker);
  if (startIdx === -1) return null;
  const endIdx = fullHtml.indexOf(endMarker, startIdx);
  const slice =
    endIdx === -1 ? fullHtml.slice(startIdx) : fullHtml.slice(startIdx, endIdx);

  const $$ = cheerio.load(slice);

  // --- WPS payouts ---
  const wpsTable = $$("table.table-payouts").first();
  if (wpsTable.length === 0) return null; // race not final yet

  // Each <tr> in tbody: [runner name td, program-number td (img alt=N), win, place, show]
  const wpsRows: { num: string; win: number; place: number; show: number }[] = [];
  wpsTable.find("tbody tr").each((_i, tr) => {
    const tds = $$(tr).find("td");
    if (tds.length < 5) return;
    const num = tidy($$(tds[1]).find("img").attr("alt"));
    if (!num) return;
    const win = parseMoney(tidy($$(tds[2]).text()));
    const place = parseMoney(tidy($$(tds[3]).text()));
    const show = parseMoney(tidy($$(tds[4]).text()));
    wpsRows.push({ num, win, place, show });
  });

  if (wpsRows.length === 0) return null;

  // The winner is the row with a non-zero Win payout.
  const winnerRow = wpsRows.find((r) => r.win > 0) ?? wpsRows[0];

  // --- Exotic payouts (Exacta / Trifecta / Superfecta) ---
  const exoticTable = $$("table.table-exotic-payouts").first();
  let exactaPayout: number | undefined;
  let trifectaPayout: number | undefined;
  let superfectaPayout: number | undefined;
  let exactaFinish = "";
  let trifectaFinish = "";
  let superfectaFinish = "";

  if (exoticTable.length > 0) {
    exoticTable.find("tbody tr").each((_i, tr) => {
      const tds = $$(tr).find("td");
      if (tds.length < 3) return;
      const pool = tidy($$(tds[0]).text()).toLowerCase();
      const finish = tidy($$(tds[1]).text());
      const payout = parseMoney(tidy($$(tds[2]).text()));
      if (pool === "exacta") {
        exactaFinish = finish;
        exactaPayout = payout;
      } else if (pool === "trifecta") {
        trifectaFinish = finish;
        trifectaPayout = payout;
      } else if (pool === "superfecta") {
        superfectaFinish = finish;
        superfectaPayout = payout;
      }
    });
  }

  // --- Build finishOrder (program numbers as strings) ---
  // Prefer Superfecta (top 4). Fall back to Trifecta + show-row, then Exacta + WPS rows.
  let finishOrder: string[] = [];
  if (superfectaFinish) {
    finishOrder = superfectaFinish.split("-").map((s) => s.trim()).filter(Boolean);
  } else if (trifectaFinish) {
    finishOrder = trifectaFinish.split("-").map((s) => s.trim()).filter(Boolean);
    // Pad 4th from any WPS row not already in finishOrder that has a show payout.
    const fourth = wpsRows.find(
      (r) => r.show > 0 && !finishOrder.includes(r.num),
    );
    if (fourth) finishOrder.push(fourth.num);
  } else if (exactaFinish) {
    finishOrder = exactaFinish.split("-").map((s) => s.trim()).filter(Boolean);
  } else {
    // Last resort: rebuild from WPS rows in payout order.
    if (winnerRow) finishOrder.push(winnerRow.num);
    for (const r of wpsRows) {
      if (r.place > 0 && !finishOrder.includes(r.num)) finishOrder.push(r.num);
    }
    for (const r of wpsRows) {
      if (r.show > 0 && !finishOrder.includes(r.num)) finishOrder.push(r.num);
    }
  }

  if (finishOrder.length === 0) return null;

  // Pull WPS payouts for the winner. (Place/Show are reported on the winner's
  // own row in HRN — the winner row shows the winner's $2 W/P/S payouts.)
  const winPayout = winnerRow.win;
  const placePayout = winnerRow.place;
  const showPayout = winnerRow.show;

  return {
    finishOrder,
    winPayout,
    placePayout,
    showPayout,
    exactaPayout,
    trifectaPayout,
    superfectaPayout,
  };
}

// Legacy export kept for any consumer that imported it directly.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseEquibaseSummary(_html: string, _raceNumber: number): EquibaseRaceResult | null {
  return null;
}
