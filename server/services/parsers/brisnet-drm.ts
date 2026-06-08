// Brisnet DRM ("PP Data Files multi") parser.
//
// The DRM download is a zip of four comma-delimited, quoted-field files per
// card (.DRF/.DR2/.DR3/.DR4). The .DR2 is the per-horse extended file: one row
// per runner, 234 fields. We parse the high-value, reliably-anchored BRIS
// fields and keep the full raw row so the rest can be re-derived later without
// a re-download (the spec explicitly allows storing the raw row).
//
// Field positions below were verified empirically against the real Finger Lakes
// 2026-06-08 fixture (server/services/__fixtures__/brisnet/flx0608n.zip). They
// are 1-indexed in the comments and 0-indexed in code. Constant-per-race fields
// (the BRIS speed/pace pars) sit on every horse row; per-horse fields vary.

import AdmZip from "adm-zip";

// 1-indexed DR2 field map (subtract 1 for array access).
export const DR2 = {
  trackCode: 1, // "FL "
  raceDate: 2, // "20260608"
  raceNumber: 3, // 1
  postPosition: 4, // program/post number for win betting on these cards
  runStyle: 189, // "E" | "P" | "E/P" | "S" | "NA"  (BRIS Race Shape / run style)
  speedParEarly: 193, // race-level BRIS early-speed par (constant per race)
  speedParLate: 194, // race-level BRIS late-speed par
  paceParE1: 196, // race-level BRIS E1 pace par
  paceParE2: 197, // race-level BRIS E2 pace par
  mlNumerator: 201, // morning-line numerator
  mlOdds: 202, // morning-line odds-to-1 (e.g. 6.00 = 6/1)
  primePower: 229, // BRIS Prime Power (single rating)
  bestSpeedSurfA: 230, // best speed by surface slot A (0 when N/A)
  bestSpeedSurfB: 231, // best speed by surface slot B
  bestSpeed: 232, // best speed (overall / at distance)
  companyLine: 233, // BRIS company-line code (encoded token)
} as const;

export interface DrmHorse {
  programNumber: string; // post position used as program number
  postPosition: number | null;
  runStyle: string | null;
  primePower: number | null;
  bestSpeed: number | null;
  bestSpeedBySurface: { a: number | null; b: number | null };
  mlOdds: number | null;
  companyLine: string | null;
  rawRow: string[]; // full DR2 row, preserved for later re-parse
}

export interface DrmRace {
  raceNumber: number;
  // BRIS pars are race-level (identical on every horse row of the race).
  speedParEarly: number | null;
  speedParLate: number | null;
  paceParE1: number | null;
  paceParE2: number | null;
  // Track-local post time from the .DRF zone field, e.g. "12:55" (null if the
  // .DRF member was absent or the field was empty).
  postTimeRaw: string | null;
  horses: DrmHorse[];
}

export interface DrmCard {
  trackCode: string; // normalized, trimmed + uppercased (e.g. "FL")
  raceDate: string; // ISO "YYYY-MM-DD"
  races: DrmRace[];
}

// Minimal RFC-4180-ish CSV: comma-delimited, double-quoted fields, no embedded
// newlines inside the BRIS rows (each horse is one physical line). Handles
// escaped "" inside quotes defensively though BRIS doesn't appear to use them.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

function at(row: string[], oneIndexed: number): string {
  return (row[oneIndexed - 1] ?? "").trim();
}

function num(s: string): number | null {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "20260608" -> "2026-06-08". Returns "" if not 8 digits.
export function drDateToIso(yyyymmdd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// Parse the .DR2 text into a structured card. Rows are grouped by race number;
// pars are read once per race off the first row seen for that race.
export function parseDr2(text: string, fallbackTrack: string): DrmCard {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const raceMap = new Map<number, DrmRace>();
  let trackCode = fallbackTrack.trim().toUpperCase();
  let raceDateIso = "";

  for (const line of lines) {
    const row = parseCsvLine(line);
    const raceNumber = Number(at(row, DR2.raceNumber));
    if (!Number.isFinite(raceNumber) || raceNumber <= 0) continue;

    const rowTrack = at(row, DR2.trackCode).toUpperCase();
    if (rowTrack) trackCode = rowTrack;
    if (!raceDateIso) raceDateIso = drDateToIso(at(row, DR2.raceDate));

    let race = raceMap.get(raceNumber);
    if (!race) {
      race = {
        raceNumber,
        speedParEarly: num(at(row, DR2.speedParEarly)),
        speedParLate: num(at(row, DR2.speedParLate)),
        paceParE1: num(at(row, DR2.paceParE1)),
        paceParE2: num(at(row, DR2.paceParE2)),
        postTimeRaw: null, // filled from the .DRF member, if present
        horses: [],
      };
      raceMap.set(raceNumber, race);
    }

    const postPosition = num(at(row, DR2.postPosition));
    race.horses.push({
      programNumber: at(row, DR2.postPosition) || String(race.horses.length + 1),
      postPosition,
      runStyle: at(row, DR2.runStyle) || null,
      primePower: num(at(row, DR2.primePower)),
      bestSpeed: num(at(row, DR2.bestSpeed)),
      bestSpeedBySurface: {
        a: num(at(row, DR2.bestSpeedSurfA)),
        b: num(at(row, DR2.bestSpeedSurfB)),
      },
      mlOdds: num(at(row, DR2.mlOdds)),
      companyLine: at(row, DR2.companyLine) || null,
      rawRow: row,
    });
  }

  const races = Array.from(raceMap.values()).sort(
    (a, b) => a.raceNumber - b.raceNumber,
  );
  for (const r of races) {
    r.horses.sort(
      (a, b) => (a.postPosition ?? 0) - (b.postPosition ?? 0),
    );
  }
  return { trackCode, raceDate: raceDateIso, races };
}

// ── Zip handling ─────────────────────────────────────────────────────────────
export interface DrmZipFiles {
  drf?: string;
  dr2?: string;
  dr3?: string;
  dr4?: string;
}

// Pull the four DR* member texts out of a DRM zip buffer, keyed by extension.
// Member names look like "FLX0608.DR2"; we match on extension, case-insensitive.
export function extractDrmZip(buf: Buffer): DrmZipFiles {
  const zip = new AdmZip(buf);
  const files: DrmZipFiles = {};
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const m = /\.(DRF|DR2|DR3|DR4)$/i.exec(entry.entryName);
    if (!m) continue;
    const text = entry.getData().toString("latin1");
    const key = m[1].toLowerCase() as keyof DrmZipFiles;
    files[key] = text;
  }
  return files;
}

// Parse the .DRF (race-info) member into a raceNumber → local post-time map.
// Each physical line is one race; field 3 is the race number and the trailing
// zone field reads "(12:55)/11:55/10:55/ 9:55" (ET/CT/MT/PT). The parenthesized
// value is the track-local post; we capture it raw and let post-time.ts convert.
export function parseDrfPostTimes(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const row = parseCsvLine(line);
    const raceNumber = Number(at(row, 3));
    if (!Number.isFinite(raceNumber) || raceNumber <= 0) continue;
    // The zone field is the last non-empty field carrying a "(h:mm)" token.
    let zoneField = "";
    for (let i = row.length - 1; i >= 0; i--) {
      if (/\(\s*\d{1,2}:\d{2}\s*\)/.test(row[i])) {
        zoneField = row[i];
        break;
      }
    }
    const paren = zoneField.match(/\(\s*(\d{1,2}:\d{2})\s*\)/);
    if (paren) out.set(raceNumber, paren[1]);
  }
  return out;
}

// Full path: zip buffer -> structured card. Requires the .DR2 member; uses the
// .DRF member for post times when present.
export function parseDrmZip(buf: Buffer, fallbackTrack: string): DrmCard {
  const files = extractDrmZip(buf);
  if (!files.dr2) {
    throw new Error("DRM zip has no .DR2 member");
  }
  const card = parseDr2(files.dr2, fallbackTrack);
  if (files.drf) {
    const postByRace = parseDrfPostTimes(files.drf);
    for (const race of card.races) {
      race.postTimeRaw = postByRace.get(race.raceNumber) ?? null;
    }
  }
  return card;
}
