import type { Race } from "@shared/schema";

export interface Grade {
  winHit: boolean;
  placeHit: boolean;
  showHit: boolean;
  fourthHit: boolean;
  itmCount: number;
  exactaHit: boolean;
  trifectaHit: boolean;
  superfectaHit: boolean;
}

export function gradeRace(race: Race, finishOrder: string[]): Grade {
  const [p1, p2, p3, p4] = finishOrder;
  const myPicks = [race.winPgm, race.placePgm, race.showPgm, race.fourthPgm];
  const top4Actual = [p1, p2, p3, p4].filter(Boolean) as string[];

  const winHit = race.winPgm === p1;
  const placeHit = race.placePgm === p1 || race.placePgm === p2;
  const showHit = [p1, p2, p3].includes(race.showPgm!);
  const fourthHit = top4Actual.includes(race.fourthPgm!);

  const itmCount = myPicks.filter((pgm) => top4Actual.includes(pgm!)).length;

  const exactaHit =
    [p1, p2].includes(race.winPgm!) &&
    [p1, p2].includes(race.placePgm!) &&
    race.winPgm !== race.placePgm;

  const top3 = [race.winPgm, race.placePgm, race.showPgm];
  const actualTop3 = [p1, p2, p3];
  const trifectaHit =
    top3.every((pgm) => actualTop3.includes(pgm!)) && new Set(top3).size === 3;

  const top4 = [...top3, race.fourthPgm];
  const actualTop4 = [p1, p2, p3, p4];
  const superfectaHit =
    top4.every((pgm) => actualTop4.includes(pgm!)) && new Set(top4).size === 4;

  return {
    winHit,
    placeHit,
    showHit,
    fourthHit,
    itmCount,
    exactaHit,
    trifectaHit,
    superfectaHit,
  };
}

// Determine which raised flags "played correctly". Heuristic for v1:
// A flag is considered correct if the win pick (the horse the flag concerns)
// behaved as the flag predicted.
//  - BOUNCE RISK   → correct if the flagged win pick did NOT win
//  - VALUE GATE    → correct if win pick hit the board (top 2)
//  - TRIP-AIDED    → correct if the win pick did NOT win
//  - FIELD SIZE    → correct if win pick did NOT win (chaos materialised)
//  - default       → correct if win pick won
export function gradeFlags(race: Race, finishOrder: string[]): string[] {
  const flags = JSON.parse(race.flags || "[]") as string[];
  const won = race.winPgm === finishOrder[0];
  const placed = [finishOrder[0], finishOrder[1]].includes(race.winPgm!);
  const hit: string[] = [];
  for (const f of flags) {
    const upper = f.toUpperCase();
    let ok = false;
    if (upper.includes("BOUNCE")) ok = !won;
    else if (upper.includes("VALUE")) ok = placed;
    else if (upper.includes("TRIP")) ok = !won;
    else if (upper.includes("FIELD")) ok = !won;
    else ok = won;
    if (ok) hit.push(f);
  }
  return hit;
}
