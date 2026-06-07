// Post-fusion "finishing" pass shared by the live upload path and the backfill.
//
// The fusion engine + LLM produce per-horse EEA Ratings and a tier, but several
// card-level fields were historically left unset on the upload path (they were
// only ever populated by the hardcoded Saratoga seed): the numeric win/place/
// show/fourth scores, a compact `conditions` string, race flags, and the
// card-level conviction. The "Ultimate PP's w/ QuickPlay Comments" (Finger
// Lakes) source also encodes the ½ fraction glyph as `î`, which has to be
// normalized before the distance/conditions read cleanly.

import type { FusedRace, FusedHorse, Tier } from "./eea-fusion";
import type { EeaWeights } from "./eea-config";
import type { IStorage } from "../storage";

// The "î" glyph is the Brisnet-decoded form of ½ in the Finger Lakes source;
// "ì"/"í" show up the same way for ¼/¾ on other half-distance cards.
export function normalizeFractions(s: string): string {
  return s
    .replace(/î/g, "½")
    .replace(/ì/g, "¼")
    .replace(/í/g, "¾");
}

// Map a furlong distance like "5½ Furlongs" / "5 1/2 Furlongs" to "5.5F", and a
// mile distance to "<n>M". Falls back to a normalized passthrough.
function compactDistance(distance: string | undefined, raw: string): string | undefined {
  const src = normalizeFractions(distance ?? raw);
  const frac = (whole: string, half: string) => {
    const w = parseInt(whole, 10);
    const f = half.includes("½") || half.includes("1/2") ? 0.5
      : half.includes("¼") || half.includes("1/4") ? 0.25
      : half.includes("¾") || half.includes("3/4") ? 0.75
      : 0;
    return w + f;
  };

  const furlong = src.match(/(\d+)\s*([½¼¾]|\d\/\d)?\s*Furlong/i);
  if (furlong) {
    const n = furlong[2] ? frac(furlong[1], furlong[2]) : parseInt(furlong[1], 10);
    return `${n}F`;
  }
  // "1m70yds" style: keep as-is but compacted.
  const mAndYds = src.match(/(\d+)\s*m\s*(\d+)\s*yds/i);
  if (mAndYds) return `${mAndYds[1]}M${mAndYds[2]}y`;
  // "1 1/16 Mile" → "1 1/16M"; plain "1 Mile" → "1M".
  const mile = src.match(/(\d+(?:\s+\d+\/\d+)?)\s*Mile/i);
  if (mile) return `${mile[1].replace(/\s+/g, " ").trim()}M`;
  return distance ? normalizeFractions(distance) : undefined;
}

// Strip the vendor header / track / date / race-number cruft from a raw
// conditions line and rebuild the compact Saratoga-style string:
//   "Alw 26500 N2L · 5.5F Dirt · RR 81"
// `raceRating` (Equibase RR) is appended when known.
export function cleanConditions(
  rawIn: string,
  opts: { surface?: string; distance?: string; raceRating?: number | null } = {},
): string {
  const raw = normalizeFractions(rawIn || "");

  // Drop the vendor banner, track name, weekday + date, and trailing race number.
  let core = raw
    .replace(/Ultimate PP'?s w\/?\s*QuickPlay Comments/gi, " ")
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b[^·]*?\b20\d\d\b/gi, " ")
    .replace(/\bRace\s*\d+\s*$/i, " ")
    .replace(/\b(?:Finger Lakes|Saratoga|Belmont|Aqueduct|Gulfstream|Churchill Downs|Keeneland|Santa Anita|Del Mar|Oaklawn|Parx|Monmouth|Laurel|Woodbine)\b/gi, " ");

  // Pull out the class/type token + claiming/allowance qualifier (Alw 26500n2L).
  const classMatch = core.match(
    /\b(Alw|Allowance|Mdn|Maiden|MSW|Clm|Claiming|OptClm|OC|Stk|Stakes|Str)\b\s*([0-9][0-9.,kbn]*[A-Za-z0-9]*)?/i,
  );
  let classPart = "";
  if (classMatch) {
    const kind = classMatch[1].replace(/^Allowance$/i, "Alw").replace(/^Maiden$/i, "Mdn").replace(/^Claiming$/i, "Clm");
    const qual = (classMatch[2] || "").trim();
    // Split a money amount from an "n2L"/"b" suffix → "26500 N2L".
    const qm = qual.match(/^([\d.,]+k?)\s*([a-zA-Z][a-zA-Z0-9]*)?$/);
    if (qm) {
      const money = qm[1];
      const cond = qm[2] ? ` ${qm[2].toUpperCase()}` : "";
      classPart = `${kind} ${money}${cond}`.trim();
    } else {
      classPart = `${kind} ${qual}`.trim();
    }
  }

  const surface = opts.surface
    ? opts.surface[0].toUpperCase() + opts.surface.slice(1).toLowerCase()
    : /Turf/i.test(raw) ? "Turf" : "Dirt";
  const dist = compactDistance(opts.distance, raw);

  const distSurface = [dist, surface].filter(Boolean).join(" ");
  const parts = [classPart, distSurface].filter((p) => p && p.length > 0);
  if (opts.raceRating != null && Number.isFinite(opts.raceRating)) {
    parts.push(`RR ${Math.round(opts.raceRating)}`);
  }
  const out = parts.join(" · ").trim();
  // If we somehow stripped everything, fall back to a collapsed raw so we never
  // persist an empty conditions cell.
  return out || raw.replace(/\s+/g, " ").trim();
}

// Round a fused EEA Rating for display in the score columns (matches the
// one-decimal precision the engine already uses).
function score(h: FusedHorse | undefined): number | null {
  if (!h || h.eeaRating == null) return null;
  return Math.round(h.eeaRating * 10) / 10;
}

export interface PickScores {
  winScore: number | null;
  placeScore: number | null;
  showScore: number | null;
  fourthScore: number | null;
}

// Look up the EEA Rating for each of the four flattened picks by program number.
export function scoresForPicks(
  fused: FusedRace,
  picks: { winPgm?: string | null; placePgm?: string | null; showPgm?: string | null; fourthPgm?: string | null },
): PickScores {
  const byPgm = new Map(fused.horses.map((h) => [h.pgm, h]));
  return {
    winScore: score(picks.winPgm ? byPgm.get(picks.winPgm) : undefined),
    placeScore: score(picks.placePgm ? byPgm.get(picks.placePgm) : undefined),
    showScore: score(picks.showPgm ? byPgm.get(picks.showPgm) : undefined),
    fourthScore: score(picks.fourthPgm ? byPgm.get(picks.fourthPgm) : undefined),
  };
}

// Derive race-level flags from the fused field. Mirrors the seed's flag style
// ("BOUNCE RISK on #4", "VALUE GATE on #2", "FIELD SIZE chaos").
export function deriveFlags(fused: FusedRace, weights: EeaWeights): string[] {
  const flags: string[] = [];
  const ranked = fused.horses.filter((h) => h.eeaRating != null);
  if (ranked.length === 0) return flags;

  const leader = ranked[0];
  const second = ranked[1];

  // BOUNCE RISK: a horse coming off a figure spike (engine tags this on the
  // per-horse flags as a speed-source spike / lone-speed in a pace duel).
  const bounce = fused.horses.find(
    (h) => h.flags.includes("projected-lone-speed") && fused.horses.filter((x) => x.flags.includes("in-pace-duel")).length === 0,
  );
  if (bounce && leader && bounce.pgm === leader.pgm) {
    flags.push(`BOUNCE RISK on #${bounce.pgm}`);
  }

  // VALUE GATE: the top two are within a half point — the 2nd is live value.
  if (
    second &&
    leader.eeaRating != null &&
    second.eeaRating != null &&
    leader.eeaRating - second.eeaRating <= 0.5
  ) {
    flags.push(`VALUE GATE on #${second.pgm}`);
  }

  // FIELD SIZE chaos: large field dilutes any single edge.
  if (fused.horses.length >= 12) flags.push("FIELD SIZE chaos");

  return flags;
}

// Card-level conviction from the per-race tiers: HIGH if any SNIPER (or 2+
// EDGE), MEDIUM if at least one actionable tier, otherwise LOW.
export function computeCardConviction(tiers: Tier[]): "HIGH" | "MEDIUM" | "LOW" {
  const snipers = tiers.filter((t) => t === "SNIPER").length;
  const edges = tiers.filter((t) => t === "EDGE").length;
  const actionable = tiers.filter((t) => t !== "PASS").length;
  if (snipers >= 1 || edges >= 2) return "HIGH";
  if (actionable >= 1) return "MEDIUM";
  return "LOW";
}

const VENDOR_CRUFT = /Ultimate PP'?s w\/?\s*QuickPlay Comments|\bRace\s*\d+\s*$/i;

// One-shot, idempotent repair for cards persisted by an older upload path that
// left the numeric scores null, the conditions full of vendor cruft, and the
// card conviction unset (e.g. Finger Lakes card id=2). Reconstructs win/place/
// show/fourth scores from the per-horse prediction rows that *do* carry the
// EEA Rating — no PDF re-upload and no LLM call required. Safe to run on every
// boot: cards that already have scores are skipped.
export function backfillNullScoreCards(storage: IStorage): number {
  let repaired = 0;
  for (const card of storage.getCards()) {
    const races = storage.getRacesByCard(card.id);
    if (races.length === 0) continue;

    // Only touch cards where every race is missing its win score — that's the
    // signature of the broken path. A partially-scored card is left alone.
    const allNullScores = races.every((r) => r.winScore == null);
    if (!allNullScores) continue;

    const tiers: Tier[] = [];
    for (const race of races) {
      const ratingByPgm = new Map<string, number | null>();
      for (const p of storage.getPredictionsByRace(race.id)) {
        ratingByPgm.set(p.horsePgm, p.eeaRating);
      }
      const lookup = (pgm: string | null) =>
        pgm && ratingByPgm.get(pgm) != null ? Math.round(ratingByPgm.get(pgm)! * 10) / 10 : null;

      const patch: Record<string, unknown> = {
        winScore: lookup(race.winPgm),
        placeScore: lookup(race.placePgm),
        showScore: lookup(race.showPgm),
        fourthScore: lookup(race.fourthPgm),
      };
      // Re-clean conditions only if they still carry the raw vendor banner.
      if (race.conditions && VENDOR_CRUFT.test(race.conditions)) {
        patch.conditions = cleanConditions(race.conditions);
      }
      storage.updateRaceFusion(race.id, patch);
      tiers.push((race.tier as Tier) ?? "PASS");
    }

    if (card.cardConviction == null) {
      storage.updateCard(card.id, { cardConviction: computeCardConviction(tiers) });
    }
    repaired++;
  }
  if (repaired > 0) {
    console.log(`[backfill] repaired ${repaired} card(s) with null numeric scores`);
  }
  return repaired;
}
