// Track bias auto-fetcher.
//
// Pulls yesterday's results for the track on today's card from HorseRacingNation
// and aggregates a coarse bias card: how the winners/in-the-money runners broke
// down by post position. v1 derives this from the per-race finish orders that
// the existing HRN results parser already exposes (program number ≈ post
// position at these tracks). Running-position / trip-note extraction (full
// charts) is intentionally deferred — the post-position read + a narrative is
// enough signal for the LLM's pace/bias lens.
//
// The result is persisted in bias_reads (one row per date+track) and passed to
// fusion + the LLM as race context. If yesterday's charts aren't up yet, we
// fall back to two days ago and note the gap.

import * as cheerio from "cheerio";
import { hrnUrlFor } from "./equibase";
import { storage } from "../storage";
import type { BiasContext } from "./eea-fusion";

export interface PostPosBias {
  starts: number;
  wins: number;
  itm: number; // in-the-money (top 3) count
}

export interface BiasCard {
  date: string;
  track: string;
  racesAnalyzed: number;
  postPos: Record<string, PostPosBias>;
  // Coarse run-style read is not derivable from finish-order alone; left null
  // in v1 but kept in the shape so the LLM payload is stable.
  runStyleBias: "speed" | "closer" | "neutral" | null;
  railBias: "good" | "bad" | "neutral" | null;
  narrative: string;
  gapNote?: string;
}

function yesterday(dateStr: string, daysBack = 1): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - daysBack);
  return dt.toISOString().slice(0, 10);
}

// Parse one HRN results page into per-race finish orders (program numbers).
function parseFinishOrders(html: string): string[][] {
  const $ = cheerio.load(html);
  const orders: string[][] = [];
  // Each race section is anchored by a.race-header#race-N. Walk N upward.
  for (let n = 1; n <= 20; n++) {
    const startMarker = `id="race-${n}"`;
    const endMarker = `id="race-${n + 1}"`;
    const startIdx = html.indexOf(startMarker);
    if (startIdx === -1) break;
    const endIdx = html.indexOf(endMarker, startIdx);
    const slice = endIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, endIdx);
    const $$ = cheerio.load(slice);
    const wps = $$("table.table-payouts").first();
    if (wps.length === 0) continue;
    const order: string[] = [];
    wps.find("tbody tr").each((_i, tr) => {
      const tds = $$(tr).find("td");
      if (tds.length < 5) return;
      const num = ($$(tds[1]).find("img").attr("alt") ?? "").trim();
      if (num) order.push(num);
    });
    if (order.length) orders.push(order);
  }
  return orders;
}

function aggregate(orders: string[][], date: string, track: string): BiasCard {
  const postPos: Record<string, PostPosBias> = {};
  const touch = (pgm: string): PostPosBias => {
    const key = pgm.replace(/[^0-9]/g, "") || pgm;
    return (postPos[key] = postPos[key] || { starts: 0, wins: 0, itm: 0 });
  };
  for (const order of orders) {
    order.forEach((pgm, idx) => {
      const b = touch(pgm);
      b.starts++;
      if (idx === 0) b.wins++;
      if (idx < 3) b.itm++;
    });
  }

  // Inside-vs-outside narrative: compare rail-to-3 win share against the field.
  const inside = ["1", "2", "3"].reduce((acc, k) => acc + (postPos[k]?.wins ?? 0), 0);
  const totalWins = orders.length;
  let railBias: BiasCard["railBias"] = "neutral";
  let narrative = `${orders.length} races analyzed.`;
  if (totalWins > 0) {
    const insideShare = inside / totalWins;
    if (insideShare >= 0.6) {
      railBias = "good";
      narrative = `Inside bias — posts 1-3 won ${inside}/${totalWins}.`;
    } else if (insideShare <= 0.2) {
      railBias = "bad";
      narrative = `Outside-favoring — posts 1-3 won only ${inside}/${totalWins}.`;
    } else {
      narrative = `Balanced post-position results (${inside}/${totalWins} from posts 1-3).`;
    }
  }

  return {
    date,
    track,
    racesAnalyzed: orders.length,
    postPos,
    runStyleBias: null,
    railBias,
    narrative,
  };
}

async function fetchPage(track: string, date: string): Promise<string | null> {
  const url = hrnUrlFor(track, date);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.error("[bias] fetch failed:", err);
    return null;
  }
}

// Fetch + aggregate yesterday's bias for the track. Falls back to 2 days ago.
// Persists to bias_reads keyed on (yesterday's date, track).
export async function fetchBias(track: string, cardDate: string): Promise<BiasCard | null> {
  for (let back = 1; back <= 2; back++) {
    const d = yesterday(cardDate, back);
    const html = await fetchPage(track, d);
    if (!html) continue;
    const orders = parseFinishOrders(html);
    if (orders.length === 0) continue;
    const card = aggregate(orders, d, track);
    if (back > 1) card.gapNote = `Yesterday's charts unavailable; used ${d} (${back} days back).`;
    storage.upsertBiasRead({
      date: d,
      track,
      biasJson: JSON.stringify(card),
      source: "hrn",
      accuracyScore: null,
      createdAt: new Date(),
    });
    return card;
  }
  return null;
}

// Get the most recent stored bias for a track, or fetch it if absent.
export async function getOrFetchBias(track: string, cardDate: string): Promise<BiasCard | null> {
  const d = yesterday(cardDate);
  const existing = storage.getBiasRead(track, d);
  if (existing) {
    try {
      return JSON.parse(existing.biasJson) as BiasCard;
    } catch {
      /* fall through to refetch */
    }
  }
  return fetchBias(track, cardDate);
}

// Collapse a BiasCard into the minimal context fusion consumes.
export function toBiasContext(card: BiasCard | null): BiasContext | undefined {
  if (!card) return undefined;
  return {
    runStyleBias: card.runStyleBias,
    railBias: card.railBias,
    note: card.narrative,
  };
}
