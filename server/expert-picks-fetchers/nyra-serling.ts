// NYRA / Andy Serling expert-picks fetcher (Belmont meet).
//
// Source: https://www.nyra.com/aqueduct/racing/talking-horses/ — the NYRA
// "Talking Horses" column carries Andy Serling's selections. When the meet is
// running at Belmont the same column is published under the Belmont path, so we
// try the Aqueduct path first and fall back to Belmont.
//
// Serling lists ranked selections per race like "Race 1\n7 - 5 - 4 - 2": the
// first number is the top pick, the rest are picks_2_4 (2nd/3rd/4th).

import * as cheerio from "cheerio";
import type { ExpertPickInput } from "@shared/schema";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard";

export const NYRA_URLS = [
  "https://www.nyra.com/aqueduct/racing/talking-horses/",
  "https://www.nyra.com/belmont/racing/talking-horses/",
];

// Parse the Talking Horses text for "Race N" blocks followed by a dash-joined
// list of program numbers. Exported for fixture-based tests.
export function parseNyraSerling(
  html: string,
  date: string,
): ExpertPickInput[] {
  const $ = cheerio.load(html);
  // Flatten to text; the column is prose with line breaks, not a table.
  const text = $("body").text().replace(/ /g, " ");
  const picks: ExpertPickInput[] = [];

  // Match "Race 3" then capture the selection run "7 - 5 - 4 - 2".
  const re = /Race\s+(\d+)[^0-9]*?(\d+(?:\s*-\s*\d+)*)/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = re.exec(text)) !== null) {
    const race = parseInt(m[1], 10);
    if (seen.has(race)) continue;
    const nums = m[2]
      .split(/\s*-\s*/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));
    if (nums.length === 0) continue;
    seen.add(race);
    picks.push({
      track: "Belmont",
      date,
      race,
      source: "nyra_serling",
      sourceHandicapper: "Andy Serling",
      topPick: nums[0],
      picks24: nums.slice(1, 4),
      rawText: m[0].trim(),
    });
  }
  return picks;
}

export async function fetchNyraSerling(
  date: string,
): Promise<ExpertPickInput[]> {
  let lastErr: unknown = null;
  for (const url of NYRA_URLS) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": UA } });
      if (!response.ok) {
        lastErr = new Error(`nyra-serling: HTTP ${response.status} for ${url}`);
        continue;
      }
      const html = await response.text();
      const picks = parseNyraSerling(html, date);
      if (picks.length > 0) return picks;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}
