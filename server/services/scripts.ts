import type { Race, Result, CardWithRaces, Settings } from "@shared/schema";

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function tierWord(tier: string): string {
  if (tier === "DUAL") return "Dual top";
  if (tier === "PASS") return "Pass";
  return `${capitalize(tier)}`;
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
    `${card.races.length} races on the card. Card conviction: ${card.cardConviction}.`,
    `${sniperCount} Snipers, ${edgeCount} Edges, ${passCount} Pass.`,
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

export function cardSummaryScript(card: CardWithRaces, stats: CardStats): string {
  return [
    `Card complete.`,
    `${card.races.length} races. ${stats.winsHit} wins, ${stats.itmHit} in the money.`,
    `Sniper tier: ${stats.sniperHits} of ${stats.sniperCount}. Edge tier: ${stats.edgeHits} of ${stats.edgeCount}.`,
    `ROI on the day: ${stats.roi >= 0 ? "plus" : "minus"} ${Math.abs(stats.roi).toFixed(0)} percent.`,
    stats.flagsHit > 0 ? `Flag accuracy: ${stats.flagsHit} of ${stats.flagsRaised} played correctly.` : "",
    `See you tomorrow.`,
  ]
    .filter(Boolean)
    .join(" ");
}
