// Bet sizing has moved to a single source of truth in ./wagers (buildWagers).
// This module is kept as a thin compatibility shim: sizeRaceBets takes the
// pre-extracted `top` array, while buildWagers derives `top` from the race row
// itself so both the Race Detail API and the Print sheet feed identical input.

import { buildWagers, type WagerSettings } from "./wagers";

export type { Tier, BetLeg, RaceBets } from "./wagers";

export interface SizingInput {
  tier: string;
  racesOnCard: number;
  settings: WagerSettings;
  // Program numbers of the top 4 picks, in rank order.
  top: string[];
}

export function sizeRaceBets(input: SizingInput) {
  const [winPgm, placePgm, showPgm, fourthPgm] = input.top;
  return buildWagers(
    {
      tier: input.tier,
      winPgm: winPgm ?? null,
      placePgm: placePgm ?? null,
      showPgm: showPgm ?? null,
      fourthPgm: fourthPgm ?? null,
    },
    input.settings,
    input.racesOnCard,
  );
}
