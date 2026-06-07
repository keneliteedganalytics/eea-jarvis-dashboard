import type { Race, Settings } from "@shared/schema";

export interface WagerLine {
  label: string;
  detail: string;
}

// Compute suggested wagers from tier + settings.
export function suggestedWagers(race: Race, s: Settings): WagerLine[] {
  const lines: WagerLine[] = [];
  const win = `#${race.winPgm} ${race.winName}`;
  const place = `#${race.placePgm} ${race.placeName}`;
  const show = `#${race.showPgm} ${race.showName}`;

  switch (race.tier) {
    case "SNIPER":
      lines.push({ label: "Win", detail: `$${s.sniperWin} on ${win}` });
      lines.push({ label: "Place", detail: `$${s.sniperPlace} on ${win}` });
      lines.push({ label: "Exacta", detail: `#${race.winPgm} / #${race.placePgm}, #${race.showPgm}` });
      lines.push({ label: "Trifecta box", detail: `#${race.winPgm}, #${race.placePgm}, #${race.showPgm}` });
      break;
    case "EDGE":
      lines.push({ label: "Win", detail: `$${s.edgeWin} on ${win}` });
      lines.push({ label: "Place", detail: `$${s.edgePlace} on ${win}` });
      lines.push({ label: "Exacta", detail: `#${race.winPgm} / #${race.placePgm}, #${race.showPgm}` });
      break;
    case "DUAL":
      lines.push({ label: "Win", detail: `$${s.dualWin} on ${win}` });
      lines.push({ label: "Win", detail: `$${s.dualWin} on ${place}` });
      lines.push({ label: "Exacta box", detail: `#${race.winPgm}, #${race.placePgm}` });
      break;
    case "RECON":
      lines.push({ label: "Win", detail: `$${s.reconWin} on ${win}` });
      lines.push({ label: "Exacta", detail: `#${race.winPgm} / #${race.placePgm}, #${race.showPgm}` });
      break;
    case "PASS":
      lines.push({ label: "Win", detail: `No win bet — PASS` });
      lines.push({ label: "Exotic spread", detail: `Cheap trifecta: #${race.winPgm}, #${race.placePgm}, #${race.showPgm}, #${race.fourthPgm}` });
      break;
  }
  return lines;
}
