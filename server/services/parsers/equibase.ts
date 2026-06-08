// Equibase "Speed Figure Analysis" PDF parser.
//
// The PDF extracts cleanly with `pdftotext -layout` (Poppler). The document
// opens with a per-race tabular "Speed Figure Analysis" section we parse here.
// Two row layouts exist:
//   - Open races:  Class | Pace(Last/Avg3/HiLife) | Speed(Last/Avg3/HiLife) | J/T
//   - Maiden races: Sire/Dam foal Pace avgs | Sire/Dam Win% | Stud Fee | J/T
//
// We detect the maiden layout from the column header ("Sire's Foals'") and from
// the presence of "wins/starts win%" tokens in the data rows.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EquibaseCard, EquibaseRace, EquibaseHorse } from "./types";

const execFileAsync = promisify(execFile);

export async function pdfToLayoutText(pdfPath: string): Promise<string> {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t || t.toUpperCase() === "NA" || t === "N/A" || t === "-") return null;
  const n = parseFloat(t.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pct(s: string | undefined): number | null {
  const n = num(s?.replace("%", ""));
  return n == null ? null : n / 100;
}

// Pull a trailing percent triple "43%  27%  33%" off the end of a row.
const TRAILING_JT = /(\d+)%\s+(\d+)%\s+(\d+)%\s*$/;

// Detect the leading "<pgm> <postpos> (<win>%) <name...>" portion.
const ROW_HEAD = /^\s*(\d+[A-Z]?)\s+(\d+)\s+\((\d+)%\)\s+(.+)$/;

interface RaceBlock {
  raceNumber: number;
  raceRating: number | null;
  conditionsRaw: string;
  postTimeRaw: string | null;
  isMaiden: boolean;
  headerKind: "open" | "maiden";
  rows: string[];
}

// Slice the leading "Speed Figure Analysis" section into per-race blocks.
export function sliceRaceBlocks(text: string): RaceBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: RaceBlock[] = [];

  // A race begins where a "Race Rating" line is followed (within a few lines) by
  // a conditions line and a "Pgm Pos. (win%) Horse" header. We walk the header
  // lines to anchor each race.
  let i = 0;
  let raceCounter = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isHeader = /Pgm\s+Pos\.\s+\(win%\)\s+Horse/.test(line);
    if (!isHeader) {
      i++;
      continue;
    }
    // We hit a column header. Look back for conditions + race rating.
    raceCounter++;
    let conditionsRaw = "";
    let raceRating: number | null = null;
    let postTimeRaw: string | null = null;
    for (let b = i - 1; b >= Math.max(0, i - 8); b--) {
      const L = lines[b];
      if (/Purse:/.test(L) || /\b(ALLOWANCE|MAIDEN|STAKES|CLAIMING|OPTIONAL)\b/.test(L)) {
        conditionsRaw = L.trim() + (conditionsRaw ? " " + conditionsRaw : "");
      }
      if (postTimeRaw == null) {
        const pt = L.match(/Post\s*Time:?\s*[0-9: ]+(?:[AP]\.?M\.?)?/i);
        if (pt) postTimeRaw = pt[0].trim();
      }
      const rr = L.match(/^\s*(\d{2,3})\s*$/);
      if (rr && raceRating == null) raceRating = parseInt(rr[1], 10);
    }
    const headerKind: "open" | "maiden" = /Win\s*%/.test(line) ? "maiden" : "open";
    // Some maiden headers wrap the "Sire's Foals'" label onto the prior line.
    const prevTwo = lines.slice(Math.max(0, i - 3), i).join(" ");
    const isMaidenLayout =
      headerKind === "maiden" || /Sire's Foals'|Dam's Foals'|Stud\b.*Fees|Wins,\s*Strts/.test(prevTwo);

    // Collect data rows until a blank gap / next section.
    const rows: string[] = [];
    let j = i + 1;
    let blanks = 0;
    while (j < lines.length) {
      const L = lines[j];
      if (ROW_HEAD.test(L) && TRAILING_JT.test(L)) {
        rows.push(L);
        blanks = 0;
      } else if (L.trim() === "") {
        blanks++;
        if (blanks >= 2 && rows.length > 0) break;
      } else if (/Pgm\s+Pos\.\s+\(win%\)\s+Horse/.test(L)) {
        break;
      } else if (rows.length > 0 && /Speed Figure Analysis for|Post Time:/.test(L)) {
        if (postTimeRaw == null) {
          const pt = L.match(/Post\s*Time:?\s*[0-9: ]+(?:[AP]\.?M\.?)?/i);
          if (pt) postTimeRaw = pt[0].trim();
        }
        break;
      } else if (postTimeRaw == null && /Post\s*Time:/i.test(L)) {
        const pt = L.match(/Post\s*Time:?\s*[0-9: ]+(?:[AP]\.?M\.?)?/i);
        if (pt) postTimeRaw = pt[0].trim();
      }
      j++;
      if (j - i > 80) break;
    }

    blocks.push({
      raceNumber: raceCounter,
      raceRating,
      conditionsRaw: conditionsRaw.trim(),
      postTimeRaw,
      isMaiden: /MAIDEN/i.test(conditionsRaw) || isMaidenLayout,
      headerKind: isMaidenLayout ? "maiden" : "open",
      rows,
    });
    i = j;
  }

  return blocks;
}

function parseOpenRow(line: string): EquibaseHorse | null {
  const head = line.match(ROW_HEAD);
  if (!head) return null;
  const pgm = head[1];
  const postPos = parseInt(head[2], 10);
  const winPct = parseInt(head[3], 10) / 100;
  let rest = head[4];

  const jt = rest.match(TRAILING_JT);
  let jockeyPct: number | null = null;
  let trainerPct: number | null = null;
  let jtPct: number | null = null;
  if (jt) {
    jockeyPct = parseInt(jt[1], 10) / 100;
    trainerPct = parseInt(jt[2], 10) / 100;
    jtPct = parseInt(jt[3], 10) / 100;
    rest = rest.slice(0, jt.index).trim();
  }

  // rest now: "<name...> <7 numbers> <Jockey / Trainer>"
  // Jockey/Trainer contains a " / ". Split there.
  let jockey: string | null = null;
  let trainer: string | null = null;
  const slashIdx = rest.lastIndexOf(" / ");
  if (slashIdx !== -1) {
    // Walk left from slash to the start of the jockey name (after the numbers).
    const beforeSlash = rest.slice(0, slashIdx);
    const afterSlash = rest.slice(slashIdx + 3).trim();
    trainer = afterSlash || null;
    // The jockey name is the trailing words of beforeSlash that are non-numeric.
    const tokens = beforeSlash.trim().split(/\s+/);
    const nameTokens: string[] = [];
    while (tokens.length) {
      const t = tokens[tokens.length - 1];
      if (/^[-+]?\d+(\.\d+)?$/.test(t) || t.toUpperCase() === "NA") break;
      nameTokens.unshift(tokens.pop()!);
    }
    jockey = nameTokens.join(" ") || null;
    rest = tokens.join(" ");
  }

  // rest now: "<name...> <up to 7 numbers>"
  const tokens = rest.trim().split(/\s+/);
  const numsTail: string[] = [];
  while (tokens.length && (/^[-+]?\d+(\.\d+)?$/.test(tokens[tokens.length - 1]) || tokens[tokens.length - 1].toUpperCase() === "NA") && numsTail.length < 7) {
    numsTail.unshift(tokens.pop()!);
  }
  const name = tokens.join(" ").trim();
  // numsTail: Class, PaceLast, PaceAvg3, PaceHiLife, SpeedLast, SpeedAvg3, SpeedHiLife
  const [classR, paceLast, paceAvg3, paceHi, spLast, spAvg3, spHi] = numsTail;

  return {
    pgm,
    postPos,
    postPosWinPct: winPct,
    name,
    classRating: num(classR),
    paceLast: num(paceLast),
    paceAvg3: num(paceAvg3),
    paceHiLife: num(paceHi),
    speedLast: num(spLast),
    speedAvg3: num(spAvg3),
    speedHiLife: num(spHi),
    jockey,
    trainer,
    jockeyPct,
    trainerPct,
    jtPct,
  };
}

function parseMaidenRow(line: string): EquibaseHorse | null {
  const head = line.match(ROW_HEAD);
  if (!head) return null;
  const pgm = head[1];
  const postPos = parseInt(head[2], 10);
  const winPct = parseInt(head[3], 10) / 100;
  let rest = head[4];

  const jt = rest.match(TRAILING_JT);
  let jockeyPct: number | null = null;
  let trainerPct: number | null = null;
  let jtPct: number | null = null;
  if (jt) {
    jockeyPct = parseInt(jt[1], 10) / 100;
    trainerPct = parseInt(jt[2], 10) / 100;
    jtPct = parseInt(jt[3], 10) / 100;
    rest = rest.slice(0, jt.index).trim();
  }

  // Jockey / Trainer split.
  let jockey: string | null = null;
  let trainer: string | null = null;
  const slashIdx = rest.lastIndexOf(" / ");
  if (slashIdx !== -1) {
    const beforeSlash = rest.slice(0, slashIdx);
    trainer = rest.slice(slashIdx + 3).trim() || null;
    const tokens = beforeSlash.trim().split(/\s+/);
    const nameTokens: string[] = [];
    while (tokens.length) {
      const t = tokens[tokens.length - 1];
      // Stop at stud fee ($...), win% token, or a wins/starts token.
      if (/^\$/.test(t) || /%$/.test(t) || /^\d+\/\d+/.test(t) || /^[-+]?\d+(\.\d+)?$/.test(t) || t.toUpperCase() === "NA") break;
      nameTokens.unshift(tokens.pop()!);
    }
    jockey = nameTokens.join(" ") || null;
    rest = tokens.join(" ");
  }

  // rest: "<name...> <sirePace> <damPace> <sirePaceX?> <damPaceX?> <sireW/S sW%> <damW/S dW%> <$studFee>"
  // Extract the stud fee ($...) and the two "wins/starts pct%" groups.
  const studFeeMatch = rest.match(/\$[\d,]+(?=\s*$)/);
  let sireStudFee: number | null = null;
  if (studFeeMatch) {
    sireStudFee = num(studFeeMatch[0]);
    rest = rest.slice(0, studFeeMatch.index).trim();
  }

  // Two "W/S P%" groups: e.g. "518/4212 12% 5/41 12%"
  const wsGroups: RegExpExecArray[] = [];
  {
    const wsRe = /(\d+)\/(\d+)\s*(\d+)%/g;
    let wm: RegExpExecArray | null;
    while ((wm = wsRe.exec(rest)) !== null) wsGroups.push(wm);
  }
  let sireFoalsWinPct: number | null = null;
  let damFoalsWinPct: number | null = null;
  if (wsGroups.length >= 1) sireFoalsWinPct = parseInt(wsGroups[0][3], 10) / 100;
  if (wsGroups.length >= 2) damFoalsWinPct = parseInt(wsGroups[1][3], 10) / 100;
  if (wsGroups.length >= 1) {
    rest = rest.slice(0, wsGroups[0].index).trim();
  }

  // Remaining leading numbers after the name are the pace averages.
  const tokens = rest.trim().split(/\s+/);
  const numsTail: string[] = [];
  while (tokens.length && (/^[-+]?\d+(\.\d+)?$/.test(tokens[tokens.length - 1]) || tokens[tokens.length - 1].toUpperCase() === "NA")) {
    numsTail.unshift(tokens.pop()!);
  }
  const name = tokens.join(" ").trim();
  // numsTail leading values: sirePaceAvg, damPaceAvg, (sireSpeed?, damSpeed?)
  const sireFoalsAvgPace = num(numsTail[0]);
  const damFoalsAvgPace = num(numsTail[1]);
  // Speed Last is often the 3rd/4th column in maiden layout; best-effort.
  const speedLast = num(numsTail[2]);
  const speedAvg3 = num(numsTail[3]);

  return {
    pgm,
    postPos,
    postPosWinPct: winPct,
    name,
    classRating: null,
    paceLast: null,
    paceAvg3: null,
    paceHiLife: null,
    sireFoalsAvgPace,
    sireFoalsWinPct,
    sireStudFee,
    damFoalsAvgPace,
    damFoalsWinPct,
    speedLast,
    speedAvg3,
    speedHiLife: null,
    jockey,
    trainer,
    jockeyPct,
    trainerPct,
    jtPct,
  };
}

export function parseEquibaseText(text: string, track: string, date: string): EquibaseCard {
  const blocks = sliceRaceBlocks(text);
  const races: EquibaseRace[] = [];

  // Only keep the leading speed-figure section: stop at the first repeated
  // race-1 once we've already collected races (the PDF appends a duplicate set
  // and detailed PP charts later).
  const seen = new Set<number>();
  for (const blk of blocks) {
    if (seen.has(blk.raceNumber)) break;
    if (blk.rows.length === 0) continue;
    seen.add(blk.raceNumber);

    const horses: EquibaseHorse[] = [];
    for (const row of blk.rows) {
      const horse =
        blk.headerKind === "maiden" ? parseMaidenRow(row) : parseOpenRow(row);
      if (horse && horse.name) horses.push(horse);
    }
    if (horses.length === 0) continue;

    races.push({
      raceNumber: blk.raceNumber,
      raceRating: blk.raceRating,
      isMaiden: blk.isMaiden,
      conditionsRaw: blk.conditionsRaw,
      postTimeRaw: blk.postTimeRaw,
      horses,
    });
  }

  return { track, date, races };
}

export async function parseEquibasePdf(
  pdfPath: string,
  track: string,
  date: string,
): Promise<EquibaseCard> {
  const text = await pdfToLayoutText(pdfPath);
  return parseEquibaseText(text, track, date);
}
