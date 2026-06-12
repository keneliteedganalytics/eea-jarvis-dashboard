// Churchill Downs official expert-picks fetcher (Kevin Kilroy).
//
// Source: https://www.churchilldowns.com/wager/expert-picks/ — the track's
// official handicapper page. Kevin Kilroy is the primary handicapper; his
// per-race selections read like "1-5/3-6": the first number is the top pick and
// the remaining numbers (split on - and /) are picks_2_4.

import * as cheerio from "cheerio";
import type { ExpertPickInput } from "@shared/schema";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard";

export const CHURCHILL_URL = "https://www.churchilldowns.com/wager/expert-picks/";

// Split a selection blob like "1-5/3-6" into program numbers in order.
function parseSelections(blob: string): number[] {
  return blob
    .split(/[\s\-/,]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));
}

// Parse the Churchill expert-picks page. Exported for fixture-based tests.
// We look for a table whose header names Kilroy, and read Race + his selections.
export function parseChurchillOfficial(
  html: string,
  date: string,
): ExpertPickInput[] {
  const $ = cheerio.load(html);
  const picks: ExpertPickInput[] = [];

  // Find the table/column for Kevin Kilroy. Header cells carry handicapper
  // names; locate the column index whose header contains "Kilroy".
  let table = $("table").filter((_, el) =>
    $(el).text().toLowerCase().includes("kilroy"),
  ).first();
  if (table.length === 0) table = $("table").first();

  const headerCells = table
    .find("tr")
    .first()
    .find("th, td")
    .toArray()
    .map((c) => $(c).text().trim().toLowerCase());
  let kilroyCol = headerCells.findIndex((h) => h.includes("kilroy"));
  if (kilroyCol < 0) kilroyCol = 1; // fall back to first data column

  table.find("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => $(td).text().trim());
    if (cells.length < 2) return;
    const raceM = cells[0].match(/(\d+)/);
    if (!raceM) return;
    const race = parseInt(raceM[1], 10);
    const blob = cells[kilroyCol] ?? cells[1];
    const nums = parseSelections(blob);
    if (nums.length === 0) return;
    picks.push({
      track: "Churchill Downs",
      date,
      race,
      source: "churchill_official",
      sourceHandicapper: "Kevin Kilroy",
      topPick: nums[0],
      picks24: nums.slice(1, 4),
      rawText: cells.join(" | "),
    });
  });

  return picks;
}

export async function fetchChurchillOfficial(
  date: string,
): Promise<ExpertPickInput[]> {
  const response = await fetch(CHURCHILL_URL, { headers: { "User-Agent": UA } });
  if (!response.ok) {
    throw new Error(`churchill-official: HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseChurchillOfficial(html, date);
}
