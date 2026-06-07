// Equibase auto-fetch infrastructure.
//
// v1 NOTE: The actual HTML parser is intentionally a STUB that returns null.
// The fetch + URL construction + track-code map are fully wired so the
// architecture is in place; the cron logs a "parser pending — use manual entry"
// message when a race's post time has passed. Manual entry is the reliable path.
// The parser can be implemented as a follow-up using cheerio (already installed).

export interface EquibaseRaceResult {
  finishOrder: string[];
  winPayout: number;
  placePayout: number;
  showPayout: number;
  exactaPayout?: number;
  trifectaPayout?: number;
  superfectaPayout?: number;
}

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

export function summaryUrlFor(track: string, date: string): string | null {
  const trackCode = TRACK_CODES[track];
  if (!trackCode) return null;
  const [y, m, d] = date.split("-");
  const mmddyy = `${m}${d}${y.slice(2)}`;
  return `https://www.equibase.com/static/chart/summary/${trackCode}${mmddyy}_USA.html`;
}

export async function fetchEquibaseResult(
  track: string,
  date: string,
  raceNumber: number,
): Promise<EquibaseRaceResult | null> {
  const url = summaryUrlFor(track, date);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 EEA-Dashboard" },
    });
    if (!response.ok) return null;
    const html = await response.text();
    return parseEquibaseSummary(html, raceNumber);
  } catch (err) {
    console.error("[equibase] fetch failed:", err);
    return null;
  }
}

// STUB for v1 — returns null so the system falls back to manual entry.
// A real implementation would use cheerio to locate the "Race N" section,
// extract the Order of Finish program numbers and the Win/Place/Show + exotic
// payouts. Returning null keeps the poller retrying without crashing.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function parseEquibaseSummary(_html: string, _raceNumber: number): EquibaseRaceResult | null {
  return null;
}
