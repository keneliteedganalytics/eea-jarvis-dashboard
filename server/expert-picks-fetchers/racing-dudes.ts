// Racing Dudes expert-picks fetcher.
//
// Source: https://racingdudes.com/track/<slug>/  — a per-track page that lists
// the day's picks in a table: Race | Pick | Odds | Trainer | Jockey. The Pick
// cell reads like "2 Holiday Cash"; we take the leading integer as the top pick.
// Racing Dudes publishes a single top selection per race (no 2nd/3rd/4th), so
// picks_2_4 is always empty for this source.

import * as cheerio from "cheerio";
import type { ExpertPickInput } from "@shared/schema";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard";

// Track key (our internal slug) -> Racing Dudes URL.
export const RACING_DUDES_URLS: Record<string, string> = {
  belmont: "https://racingdudes.com/track/belmont/",
  charles_town: "https://racingdudes.com/track/charles-town/",
  churchill_downs: "https://racingdudes.com/track/churchill-downs/",
  penn_national: "https://racingdudes.com/track/penn-national/",
  thistledown: "https://racingdudes.com/track/thistledown/",
  assiniboia_downs: "https://racingdudes.com/track/assiniboia-downs/",
};

// Display name written into the rows for each track key.
const TRACK_DISPLAY: Record<string, string> = {
  belmont: "Belmont",
  charles_town: "Charles Town",
  churchill_downs: "Churchill Downs",
  penn_national: "Penn National",
  thistledown: "Thistledown",
  assiniboia_downs: "Assiniboia Downs",
};

// Pull the leading program number out of a pick cell like "2 Holiday Cash".
function leadingInt(text: string): number | null {
  const m = text.trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Parse a Racing Dudes track page. Exported for fixture-based tests so we never
// hit the live site under test. trackDisplay/date are stamped onto each row.
export function parseRacingDudes(
  html: string,
  trackDisplay: string,
  date: string,
): ExpertPickInput[] {
  const $ = cheerio.load(html);
  const picks: ExpertPickInput[] = [];

  // The picks table has a header row containing "Race" and "Pick". Find the
  // first table whose header mentions both and parse its body rows.
  let table = $("table").filter((_, el) => {
    const head = $(el).find("tr").first().text().toLowerCase();
    return head.includes("race") && head.includes("pick");
  }).first();
  if (table.length === 0) table = $("table").first();

  table.find("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => $(td).text().trim());
    if (cells.length < 2) return; // header / spacer rows have <td>
    const race = leadingInt(cells[0]);
    const top = leadingInt(cells[1]);
    if (race === null || top === null) return;
    picks.push({
      track: trackDisplay,
      date,
      race,
      source: "racingdudes",
      sourceHandicapper: "Racing Dudes",
      topPick: top,
      picks24: [],
      rawText: cells.join(" | "),
    });
  });

  return picks;
}

export async function fetchRacingDudes(
  trackKey: string,
  date: string,
): Promise<ExpertPickInput[]> {
  const url = RACING_DUDES_URLS[trackKey];
  if (!url) throw new Error(`racing-dudes: unknown track "${trackKey}"`);
  const display = TRACK_DISPLAY[trackKey] ?? trackKey;
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) {
    throw new Error(`racing-dudes: HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();
  return parseRacingDudes(html, display, date);
}
