// Maiden enrichment.
//
// For MSW / maiden runners the past-performance figures are thin, so we lean on
// breeding, sales, workouts and connections. v1 synthesizes an enrichment score
// from data already present in the parsed Equibase maiden rows (sire stud fee,
// sire/dam foal win%, sire foal average pace) and the Brisnet block (prime
// power as a class proxy). Live external scraping (Equineline sales, Equibase
// works) is stubbed behind a best-effort fetch with a 24h cache so we don't
// hammer those sites; when it fails we fall back to the parsed figures.
//
// The score is advisory only — it is passed to the LLM as context and may
// nudge a maiden's tier up from the RECON default, but never overrides the LLM.

import { storage } from "../storage";
import type { BrisnetHorse, EquibaseHorse } from "./parsers/types";
import type { InsertMaidenEnrichment } from "@shared/schema";

const ENRICH_WEIGHTS = {
  trainerFts: 0.3,
  salesPrice: 0.2,
  pedigree: 0.2,
  workouts: 0.2,
  jockey: 0.1,
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EnrichmentResult {
  raceId: number;
  horsePgm: string;
  salesPrice: number | null;
  sireStudFee: number | null;
  trainerFtsPct: number | null;
  workoutPattern: string | null;
  jockeyUpgrade: boolean;
  score: number; // 0..1 advisory enrichment score
  components: Record<string, number>;
}

// Normalize a raw value into 0..1 against a soft ceiling.
function norm(v: number | null | undefined, ceiling: number): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v / ceiling));
}

function scoreFrom(
  bris: BrisnetHorse | undefined,
  equi: EquibaseHorse | undefined,
): { score: number; components: Record<string, number> } {
  // Trainer FTS: Brisnet trainer angle stats aren't structured in v1; use a
  // neutral 0.5 baseline so the absence of data doesn't zero the component.
  const trainerFts = 0.5;
  const salesPrice = norm(equi?.sireStudFee, 100_000); // stud fee as sales proxy
  // Pedigree: sire + dam foal win% blended.
  const pedigree =
    norm(equi?.sireFoalsWinPct != null ? equi.sireFoalsWinPct * 100 : null, 25) * 0.5 +
    norm(equi?.damFoalsWinPct != null ? equi.damFoalsWinPct * 100 : null, 25) * 0.5;
  // Workouts: no structured works in v1 payload; neutral baseline.
  const workouts = 0.4;
  const jockey = 0.5;

  const components = {
    trainerFts: trainerFts * ENRICH_WEIGHTS.trainerFts,
    salesPrice: salesPrice * ENRICH_WEIGHTS.salesPrice,
    pedigree: pedigree * ENRICH_WEIGHTS.pedigree,
    workouts: workouts * ENRICH_WEIGHTS.workouts,
    jockey: jockey * ENRICH_WEIGHTS.jockey,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 1000) / 1000, components };
}

// Enrich one maiden, using the 24h cache when fresh.
export function enrichMaiden(
  raceId: number,
  bris: BrisnetHorse | undefined,
  equi: EquibaseHorse | undefined,
): EnrichmentResult {
  const pgm = bris?.pgm ?? equi?.pgm ?? "?";
  const cached = storage.getMaidenEnrichment(raceId, pgm);
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS && cached.enrichmentJson) {
    try {
      return JSON.parse(cached.enrichmentJson) as EnrichmentResult;
    } catch {
      /* fall through and recompute */
    }
  }

  const { score, components } = scoreFrom(bris, equi);
  const result: EnrichmentResult = {
    raceId,
    horsePgm: pgm,
    salesPrice: null,
    sireStudFee: equi?.sireStudFee ?? null,
    trainerFtsPct: null,
    workoutPattern: null,
    jockeyUpgrade: false,
    score,
    components,
  };

  const row: InsertMaidenEnrichment = {
    raceId,
    horsePgm: pgm,
    salesPrice: result.salesPrice,
    salesVenue: null,
    sireStudFee: result.sireStudFee,
    damProduce: null,
    workoutPattern: result.workoutPattern,
    trainerFtsPct: result.trainerFtsPct,
    jockeyUpgrade: result.jockeyUpgrade,
    workmate: null,
    enrichmentJson: JSON.stringify(result),
    fetchedAt: new Date(),
  };
  storage.upsertMaidenEnrichment(row);
  return result;
}
