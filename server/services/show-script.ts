// Daily Show script generator. Produces a broadcast two-host script — Jarvis
// (lead analyst: tiers, pace, edges, conviction) trading off with Scarlett
// (paddock observation, track/weather, color). Deterministic + pure so the
// segment shape and word budgets are unit-testable; the persona tone lives in
// the phrasing here, and each line is TTS-sanitized so the Veo prompt embeds
// speakable copy (money, odds, distances, abbreviations already spoken out).

import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import { pluralize, numberWord, isAre } from "./text";
import { sanitizeForTTS } from "./tts";

export type Speaker = "jarvis" | "scarlett";
export interface SpeakerLine {
  speaker: Speaker;
  text: string;
}
export interface ShowScriptSegment {
  raceId: number;
  raceNumber: number;
  label: string;
  speakerLines: SpeakerLine[];
  durationHintSec: number;
}
export interface ShowScript {
  overview: { speakerLines: SpeakerLine[]; durationHintSec: number };
  races: ShowScriptSegment[];
}

// Budgets keep clips short (Veo caps at 8s; tight pacing reads better).
export const OVERVIEW_WORD_BUDGET = 60;
export const RACE_WORD_BUDGET = 45;

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

function tierWord(tier: string): string {
  if (tier === "DUAL") return "Dual";
  if (tier === "PASS") return "Pass";
  return capitalize(tier);
}

function flagsOf(race: RaceWithResult): string[] {
  try {
    return JSON.parse(race.flags || "[]") as string[];
  } catch {
    return [];
  }
}

function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function lineWords(lines: SpeakerLine[]): number {
  return lines.reduce((n, l) => n + countWords(l.text), 0);
}

// Trim a script to a word budget. First drop whole trailing lines (the least
// essential, since color/flag lines are appended last), preferring to keep the
// Jarvis→Scarlett hand-off. If the two essential lines still exceed budget,
// hard-trim the last remaining line's words so the budget is always honored.
function trimToBudget(lines: SpeakerLine[], budget: number): SpeakerLine[] {
  const out = [...lines];
  while (lineWords(out) > budget && out.length > 2) out.pop();
  if (lineWords(out) > budget && out.length === 2) {
    // Keep the lead line intact; clip the second line to fit the remainder.
    const remaining = Math.max(1, budget - countWords(out[0].text));
    const words = out[1].text.trim().split(/\s+/).slice(0, remaining);
    out[1] = { speaker: out[1].speaker, text: words.join(" ") };
  }
  return out;
}

// Sanitize each line for TTS so the Veo prompt carries speakable dialogue.
function sanitizeLines(lines: SpeakerLine[]): SpeakerLine[] {
  return lines.map((l) => ({ speaker: l.speaker, text: sanitizeForTTS(l.text) }));
}

// Roughly 2.6 words/sec spoken; clamp to Veo's 8s clip ceiling with a floor so
// even a one-line segment gets enough runtime.
function durationHint(lines: SpeakerLine[]): number {
  const words = lineWords(lines);
  return Math.max(6, Math.min(8, Math.round(words / 2.6)));
}

function buildOverview(card: CardWithRaces): { speakerLines: SpeakerLine[]; durationHintSec: number } {
  const sniper = card.races.filter((r) => r.tier === "SNIPER").length;
  const edge = card.races.filter((r) => r.tier === "EDGE").length;
  const pass = card.races.filter((r) => r.tier === "PASS").length;
  const top =
    card.races.find((r) => r.tier === "SNIPER") ??
    card.races.find((r) => r.tier === "EDGE") ??
    card.races[0];

  const tierBits = [
    sniper > 0 ? pluralize(sniper, "Sniper") : "",
    edge > 0 ? pluralize(edge, "Edge") : "",
    pass > 0 ? `${pluralize(pass, "Pass", "Pass")} to skip` : "",
  ].filter(Boolean);
  const tierLine = tierBits.length ? tierBits.join(", ") : "no standout plays";

  const lines: SpeakerLine[] = [
    {
      speaker: "jarvis",
      text: `Welcome to the Trackside Daily Show. ${pluralize(card.races.length, "race")} at ${card.track} today, card conviction ${capitalize(card.cardConviction ?? "medium")}.`,
    },
    {
      speaker: "scarlett",
      text: `Beautiful morning at the paddock — the board sets up with ${tierLine}.`,
    },
  ];
  if (top) {
    lines.push({
      speaker: "jarvis",
      text: `Our play of the day is Race ${top.raceNumber}, the ${tierWord(top.tier)} spot — ${top.winName} on top.`,
    });
    lines.push({
      speaker: "scarlett",
      text: `I'll be watching the walking ring there. Let's break it down race by race.`,
    });
  }

  const trimmed = sanitizeLines(trimToBudget(lines, OVERVIEW_WORD_BUDGET));
  return { speakerLines: trimmed, durationHintSec: durationHint(trimmed) };
}

// Short label for the playlist sidebar: "R1 Alw 26500 N2L" style. Falls back to
// just the race number when conditions are missing.
export function raceLabel(race: RaceWithResult): string {
  const cond = (race.conditions ?? "").split("·")[0].trim();
  return cond ? `R${race.raceNumber} ${cond}` : `R${race.raceNumber}`;
}

function buildRaceSegment(race: RaceWithResult): ShowScriptSegment {
  const flags = flagsOf(race);
  const isPass = race.tier === "PASS";

  const lines: SpeakerLine[] = [];
  if (isPass) {
    lines.push({
      speaker: "jarvis",
      text: `Race ${race.raceNumber} is a Pass for us — the numbers don't separate, no edge worth the risk.`,
    });
    lines.push({
      speaker: "scarlett",
      text: `Agreed, nothing in the post parade changes that. We move on.`,
    });
  } else {
    lines.push({
      speaker: "jarvis",
      text: `Race ${race.raceNumber}, ${tierWord(race.tier)} tier. ${race.winName}, number ${race.winPgm}, tops it on a ${race.winScore} rating.`,
    });
    // Keep Scarlett's color clause short so the two essential lines stay within
    // the race budget without mid-sentence clipping.
    const shapeBit = race.shape ? race.shape.split(/[,—]/)[0].trim() : "Pace looks honest";
    lines.push({
      speaker: "scarlett",
      text: `${shapeBit}. ${race.placeName} is the one I like underneath.`,
    });
    if (flags.length) {
      lines.push({
        speaker: "jarvis",
        text: `Watch the ${flags.join(" and ")} — that's the angle that pays here.`,
      });
    }
  }

  const trimmed = sanitizeLines(trimToBudget(lines, RACE_WORD_BUDGET));
  return {
    raceId: race.id,
    raceNumber: race.raceNumber,
    label: raceLabel(race),
    speakerLines: trimmed,
    durationHintSec: durationHint(trimmed),
  };
}

export function buildShowScript(card: CardWithRaces): ShowScript {
  const sorted = [...card.races].sort((a, b) => a.raceNumber - b.raceNumber);
  return {
    overview: buildOverview(card),
    races: sorted.map(buildRaceSegment),
  };
}

// Flatten a segment's lines into a single spoken transcript with explicit
// speaker turns — embedded into the Veo prompt as the dialogue track.
export function dialogueTranscript(lines: SpeakerLine[]): string {
  return lines
    .map((l) => `${l.speaker === "jarvis" ? "Jarvis" : "Scarlett"}: ${l.text}`)
    .join("\n");
}

// Re-export so callers/tests have the agreement helper handy.
export { isAre, numberWord };
