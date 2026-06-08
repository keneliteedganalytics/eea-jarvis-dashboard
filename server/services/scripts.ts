import type { Race, Result, CardWithRaces, Settings } from "@shared/schema";
import { pluralize, numberWord } from "./text";

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function tierWord(tier: string): string {
  if (tier === "DUAL") return "Dual top";
  if (tier === "PASS") return "Pass";
  return `${capitalize(tier)}`;
}

// Render a tier-count list for the spoken brief with natural plural agreement.
// Each entry is [count, singular, plural?]. Zero-count tiers are dropped so we
// never say "0 snipers"; if every tier is empty we fall back to "no plays".
function tierDistribution(entries: [number, string, string?][]): string {
  const parts = entries
    .filter(([n]) => n > 0)
    .map(([n, singular, plural]) => pluralize(n, singular, plural));
  return parts.length ? parts.join(", ") : "no plays";
}

function formatDate(date: string): string {
  // YYYY-MM-DD → "June 7th, 2026"
  try {
    const [y, m, d] = date.split("-").map(Number);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${months[m - 1]} ${d}, ${y}`;
  } catch {
    return date;
  }
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function flagsOf(race: Race): string[] {
  try {
    return JSON.parse(race.flags || "[]") as string[];
  } catch {
    return [];
  }
}

export function raceBriefingScript(race: Race, brief = false): string {
  const intro = brief
    ? `Race ${race.raceNumber}. ${race.tier === "PASS" ? "Pass." : `${tierWord(race.tier)} tier.`}`
    : `Race ${race.raceNumber}. ${tierWord(race.tier)} tier. Post time ${race.post}. ${race.conditions}.`;

  const top = `${race.winName}, number ${race.winPgm}, on top with a ${race.winScore} rating.`;
  const next = `${race.placeName} sits second. ${race.showName} third. ${race.fourthName} rounds out the top four.`;
  const flags = flagsOf(race);
  const flagLine = flags.length ? `Flag: ${flags.join(", ")}.` : "";
  const read = race.read ? `The read: ${race.read}` : "";

  return brief
    ? `${intro} ${top} ${race.shape}.`
    : [intro, top, next, flagLine, read].filter(Boolean).join(" ");
}

export function cardBriefingScript(card: CardWithRaces): string {
  const sniperCount = card.races.filter((r) => r.tier === "SNIPER").length;
  const edgeCount = card.races.filter((r) => r.tier === "EDGE").length;
  const passCount = card.races.filter((r) => r.tier === "PASS").length;
  const topRace =
    card.races.find((r) => r.tier === "SNIPER" && r.conditions?.includes("G3")) ??
    card.races.find((r) => r.tier === "SNIPER");

  return [
    `Good morning. ${card.track}, ${formatDate(card.date)}.`,
    `${pluralize(card.races.length, "race")} on the card. Card conviction: ${card.cardConviction}.`,
    `${tierDistribution([
      [sniperCount, "Sniper"],
      [edgeCount, "Edge"],
      [passCount, "Pass", "Pass"],
    ])}.`,
    topRace
      ? `Play of the day: Race ${topRace.raceNumber}. ${topRace.conditions}. ${topRace.shape}.`
      : "",
    `Let's walk it.`,
    ...card.races.map((r) => raceBriefingScript(r, true)),
    `That's the card. Good luck out there.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function raceRecapScript(race: Race, result: Result): string {
  const order = JSON.parse(result.finishOrder) as string[];
  const winner = `${order[0]}`;
  const winnerMatch = race.winPgm === order[0];

  const grade = winnerMatch
    ? `${race.winName} wins as projected. ${tierWord(race.tier)} win bet cashes.`
    : `${race.winName} did not fire. Winner: number ${winner}.`;

  const placeOk = race.placePgm === order[0] || race.placePgm === order[1];
  const place = placeOk ? `Place hits — ${race.placeName} in the top two.` : `Place miss.`;
  const showOk = [order[0], order[1], order[2]].includes(race.showPgm!);
  const show = showOk ? `Show holds — ${race.showName} in the trifecta.` : `Show miss.`;

  const exacta = result.exactaHit ? "Exacta cashes." : "Exacta busted.";
  const tri = result.trifectaHit ? "Trifecta cashes." : "Trifecta missed.";

  // Build payout line piece-by-piece so we only mention pools that actually paid.
  const payoutParts: string[] = [];
  if (result.winPayout) payoutParts.push(`Win paid ${formatMoney(result.winPayout)}`);
  if (result.placePayout) payoutParts.push(`place ${formatMoney(result.placePayout)}`);
  if (result.showPayout) payoutParts.push(`show ${formatMoney(result.showPayout)}`);
  if (result.exactaPayout) payoutParts.push(`exacta ${formatMoney(result.exactaPayout)}`);
  if (result.trifectaPayout) payoutParts.push(`trifecta ${formatMoney(result.trifectaPayout)}`);
  if (result.superfectaPayout) payoutParts.push(`superfecta ${formatMoney(result.superfectaPayout)}`);
  const payout = payoutParts.length ? `${payoutParts.join(", ")}.` : "";

  const itm = `${result.itmCount} of 4 picks in the money.`;

  // Use periods between clauses so ElevenLabs pauses naturally.
  return [
    `Race ${race.raceNumber} final.`,
    `Order of finish: ${order.join(", ")}.`,
    grade,
    place,
    show,
    exacta,
    tri,
    payout,
    itm,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export interface CardStats {
  winsHit: number;
  itmHit: number;
  sniperHits: number;
  sniperCount: number;
  edgeHits: number;
  edgeCount: number;
  roi: number;
  flagsHit: number;
  flagsRaised: number;
}

// "Sniper tier: 1 of 3." with natural agreement, or "" when the tier had no
// plays (we don't recap a tier we never bet).
function tierHitLine(label: string, hits: number, count: number): string {
  if (count === 0) return "";
  return `${label} tier: ${numberWord(hits)} of ${numberWord(count)}.`;
}

export function cardSummaryScript(card: CardWithRaces, stats: CardStats): string {
  return [
    `Card complete.`,
    `${pluralize(card.races.length, "race")}. ${pluralize(stats.winsHit, "win")}, ${pluralize(stats.itmHit, "pick")} in the money.`,
    tierHitLine("Sniper", stats.sniperHits, stats.sniperCount),
    tierHitLine("Edge", stats.edgeHits, stats.edgeCount),
    `ROI on the day: ${stats.roi >= 0 ? "plus" : "minus"} ${Math.abs(stats.roi).toFixed(0)} percent.`,
    stats.flagsRaised > 0
      ? `Flag accuracy: ${numberWord(stats.flagsHit)} of ${pluralize(stats.flagsRaised, "flag")} played correctly.`
      : "",
    `See you tomorrow.`,
  ]
    .filter(Boolean)
    .join(" ");
}
