// Brisnet "Ultimate PP's" PDF parser.
//
// CRITICAL: Brisnet embeds a custom font whose glyph codes are the real
// character + 0x1F. The default text layer is therefore garbled
// ("Hidden Rose" -> ")JEEFO3PTF"). We extract via pdfjs-dist
// (which gives us positioned glyphs) and decode every code point by +0x1F.
//
// The decode was verified empirically against the Finger Lakes 2026-06-08
// fixture: "6MUJNBUF" -> "Ultimate", "$PQZSJHIU" -> "Copyright", spaces
// (0x01) -> 0x20. See test-fixtures + server/__tests__/brisnet.test.ts.
//
// What we extract per race:
//   1. The full horse roster, anchored on each horse's per-PP block. Every
//      runner has a dedicated block with a name line ("<Name> <RunStyle> <n>"),
//      a breeding line carrying "Prime Power: NNN.N", and a career-summary data
//      row whose leading integer is the program number. This recovers the whole
//      field (the figure-leader rows only list the top few per figure).
//   2. The four Brisnet figure-leader summary rows that head each race ("Speed
//      Last Race", "Prime Power", "Class Rating", "Best Speed at Distance"),
//      which supply speedLast / classRating / bestSpeedDist per pgm.
// Roster = union of PP blocks; figures are merged in by pgm.

import { readFileSync } from "node:fs";
import type { BrisnetCard, BrisnetRace, BrisnetHorse, RaceConditions } from "./types";

// Decode one Brisnet-encoded string: shift each glyph code by +0x1F back to ASCII.
export function decodeBrisnet(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // Glyph codes land in roughly 0x01..0xE0; the font uses 0x01 for space.
    if (code >= 0x01 && code <= 0xe0) {
      out += String.fromCharCode(code + 0x1f);
    } else {
      out += ch;
    }
  }
  return out;
}

interface Cell {
  x: number;
  s: string;
}
interface PageLine {
  y: number;
  cells: Cell[];
  text: string;
}
interface PageData {
  page: number;
  lines: PageLine[];
}

async function extractPages(pdfPath: string): Promise<PageData[]> {
  // pdfjs legacy build is a CommonJS / ESM hybrid; load via dynamic import for tsx.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PageData[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY: Record<number, Cell[]> = {};
    for (const item of tc.items as { str: string; transform: number[] }[]) {
      if (!item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      (byY[y] = byY[y] || []).push({
        x: Math.round(item.transform[4]),
        s: decodeBrisnet(item.str),
      });
    }
    const lines: PageLine[] = Object.keys(byY)
      .map(Number)
      .sort((a, b) => b - a)
      .map((y) => {
        const cells = byY[y].sort((a, b) => a.x - b.x);
        return { y, cells, text: cells.map((c) => c.s).join(" ") };
      });
    pages.push({ page: p, lines });
  }
  return pages;
}

// Parse a race-header line into structured conditions.
// e.g. 'Ultimate PP's ... Finger"Lakes ©Alw  26500n2L?1 Mile   3&up? F & M Tuesday? June 09? 2026 Race"1'
export function parseConditions(raw: string): { raceNumber: number; conditions: RaceConditions } {
  const cleaned = raw.replace(/["?©]+/g, " ").replace(/\s+/g, " ").trim();
  const rnMatch = cleaned.match(/Race\s+(\d+)\s*$/);
  const raceNumber = rnMatch ? parseInt(rnMatch[1], 10) : 0;

  let type = "UNKNOWN";
  if (/\bMaiden|\bMdn|\bMC\b|\bMSW\b|\bMcl\b|\bMd\b/i.test(cleaned)) type = "MAIDEN";
  else if (/\bAlw\b|Allowance/i.test(cleaned)) type = "ALW";
  else if (/\bStakes\b|\bStk\b|\(G[123]\)/i.test(cleaned)) type = "STK";
  else if (/\bClm\b|Claiming|\bOC\b|OptClm/i.test(cleaned)) type = "CLM";

  const distMatch = cleaned.match(/(\d+(?:\s+\d+\/\d+)?)\s*(?:Mile|Miles|M\b|F\b|Furlong)/i);
  const distance = distMatch ? distMatch[0].trim() : undefined;
  const surface = /Turf/i.test(cleaned) ? "TURF" : /Dirt/i.test(cleaned) ? "DIRT" : undefined;
  const purseMatch = cleaned.match(/(\d{4,6})n?/);
  const purse = purseMatch ? parseInt(purseMatch[1], 10) : undefined;

  return {
    raceNumber,
    conditions: {
      type,
      raw: cleaned,
      distance,
      surface,
      purse,
      ageRestriction: /3&up|3\s*up|3UP/i.test(cleaned) ? "3UP" : undefined,
      sexRestriction: /F\s*&\s*M/i.test(cleaned) ? "F&M" : undefined,
    },
  };
}

// ── Figure-leader rows ──────────────────────────────────────────────────────
// "<pgm> <Name> <value>" cells, up to 4 per physical line (one per column).
const CELL = /(\d+[A-Z]?)\s+([A-Za-z][A-Za-z'.\- ]+?)\s+(\d+(?:\.\d+)?)/g;

interface FigureLeader {
  pgm: string;
  name: string;
  value: number;
}

// ES3-safe matchAll: collect all CELL matches without spreading an iterator.
function matchAllCells(line: string): RegExpExecArray[] {
  const re = new RegExp(CELL.source, "g");
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m);
  return out;
}

function isLeaderLine(line: string): boolean {
  if (/\d{2}[A-Za-z]{3}\d{2}|:\d\d|Speed.Last.Race|Prime.Power|Class.Rating|Best.Speed/.test(line)) {
    return false;
  }
  return matchAllCells(line).length >= 2;
}

// Returns up to 4 columns of leaders (Speed, Prime, Class, BestSpeed).
function parseLeaderColumns(lines: string[]): FigureLeader[][] {
  const labelIdx = lines.findIndex(
    (l) => /Speed.Last.Race/.test(l) && /Prime.Power/.test(l) && /Class.Rating/.test(l),
  );
  if (labelIdx === -1) return [];
  const columns: FigureLeader[][] = [[], [], [], []];
  for (let i = labelIdx + 1; i < Math.min(labelIdx + 6, lines.length); i++) {
    const line = lines[i];
    if (!isLeaderLine(line)) {
      if (columns[0].length > 0) break;
      continue;
    }
    const cells = matchAllCells(line);
    cells.slice(0, 4).forEach((c, idx) => {
      columns[idx].push({ pgm: c[1], name: c[2].trim(), value: parseFloat(c[3]) });
    });
  }
  return columns;
}

// ── Per-horse PP blocks (full roster) ───────────────────────────────────────
// A horse block opens with a name line at x≈36. In the decoded glyph stream the
// font maps several separators to punctuation, so the raw cell reads like
// `Rose"Lisa"?E"2` — `"` separates name words, `"?` precedes the run-style code,
// `"` precedes a trailing rank digit. After collapsing `"` and `?` to spaces it
// becomes "Rose Lisa E 2". Immediately below the name band is a career-summary
// row whose leading token is the program number ("3 2026 4 1 - 0 ...").  The
// breeding line just above carries "Prime Power: NNN.N".
const NAME_LINE = /^([A-Za-z][A-Za-z'.\- ]+?)\s+(E\/P|E|P|S|NA)\s+(\d+)$/;
const sepClean = (s: string) => s.replace(/["?©]+/g, " ").replace(/\s+/g, " ").trim();
const PRIME_POWER = /Prime\s*Power:\s*(\d+(?:\.\d+)?)/;

interface PpBlock {
  pgm: string;
  name: string;
  primePower: number | null;
}

function parsePpBlocks(lines: PageLine[]): PpBlock[] {
  const blocks: PpBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Name line: a single cell starting near x=36 that matches "<Name> <RunStyle> <n>".
    const first = line.cells[0];
    if (!first || first.x < 30 || first.x > 80) continue;
    const m = sepClean(line.text).match(NAME_LINE);
    if (!m) continue;
    const name = m[1].trim();
    if (/^(Own|Sire|Dam|Brdr|Trnr)$/i.test(name)) continue;

    // Program number: leading integer of the next data line below.
    let pgm: string | null = null;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const pm = sepClean(lines[j].text).match(/^(\d+[A-Z]?)\s+(?:20\d\d|Life)/);
      if (pm) {
        pgm = pm[1];
        break;
      }
    }
    if (!pgm) continue;

    // Prime Power lives on the breeding line just above the name line.
    let primePower: number | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const ppm = sepClean(lines[j].text).match(PRIME_POWER);
      if (ppm) {
        primePower = parseFloat(ppm[1]);
        break;
      }
    }

    blocks.push({ pgm, name, primePower });
  }
  return blocks;
}

export function parseBrisnetPages(
  pages: PageData[],
  track: string,
  date: string,
): BrisnetCard {
  // Group pages by race using the header line.
  const raceMap = new Map<
    number,
    { conditions: RaceConditions; lines: PageLine[] }
  >();
  let currentRace = 0;
  for (const pg of pages) {
    const hdr = pg.lines.find(
      (l) => /Ultimate/.test(l.text) && /Race\s*["?]?\d/.test(l.text),
    );
    if (hdr) {
      const { raceNumber, conditions } = parseConditions(hdr.text);
      if (raceNumber) {
        currentRace = raceNumber;
        if (!raceMap.has(raceNumber)) raceMap.set(raceNumber, { conditions, lines: [] });
      }
    }
    if (currentRace && raceMap.has(currentRace)) {
      raceMap.get(currentRace)!.lines.push(...pg.lines);
    }
  }

  const races: BrisnetRace[] = [];
  const sortedRaces = Array.from(raceMap.entries()).sort((a, b) => a[0] - b[0]);
  for (const [raceNumber, data] of sortedRaces) {
    const textLines = data.lines.map((l) => l.text);
    const cols = parseLeaderColumns(textLines);
    const [speedCol = [], primeCol = [], classCol = [], bestCol = []] = cols;
    const ppBlocks = parsePpBlocks(data.lines);

    const horses = new Map<string, BrisnetHorse>();
    const ensure = (pgm: string, name: string): BrisnetHorse => {
      let h = horses.get(pgm);
      if (!h) {
        h = { pgm, name, pace: {} };
        horses.set(pgm, h);
      } else if (name.length > (h.name?.length ?? 0)) {
        h.name = name;
      }
      return h;
    };

    // Full roster + prime power from the per-horse blocks.
    for (const b of ppBlocks) {
      const h = ensure(b.pgm, b.name);
      if (b.primePower != null) h.primePower = b.primePower;
    }
    // Merge in the remaining figures by pgm from the leader rows.
    for (const l of speedCol) ensure(l.pgm, l.name).speedLast = l.value;
    for (const l of primeCol) {
      const h = ensure(l.pgm, l.name);
      if (h.primePower == null) h.primePower = l.value;
    }
    for (const l of classCol) ensure(l.pgm, l.name).classRating = l.value;
    for (const l of bestCol) ensure(l.pgm, l.name).bestSpeedDist = l.value;

    races.push({
      raceNumber,
      conditions: data.conditions,
      horses: Array.from(horses.values()).sort(
        (a, b) => parseInt(a.pgm, 10) - parseInt(b.pgm, 10),
      ),
    });
  }

  return { track, date, races };
}

export async function parseBrisnetPdf(
  pdfPath: string,
  track: string,
  date: string,
): Promise<BrisnetCard> {
  const pages = await extractPages(pdfPath);
  return parseBrisnetPages(pages, track, date);
}
