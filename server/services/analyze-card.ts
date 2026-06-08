// Card analysis orchestrator: parse both PDFs → fuse each race → enrich maidens
// → fetch yesterday's bias → call the LLM per race → persist a card with race
// rows and per-horse predictions. Returns the new card id for the Review screen.
//
// The card is created unpublished (locked = false). The Review & Confirm screen
// reads it back, the user edits/approves, then POST /publish flips locked = true
// so it becomes the active card the dashboard + result poller act on.

import { storage } from "../storage";
import { parseBrisnetPdf } from "./parsers/brisnet";
import { parseEquibasePdf } from "./parsers/equibase";
import { fuseRace, assignTier, type Tier } from "./eea-fusion";
import {
  cleanConditions,
  scoresForPicks,
  deriveFlags,
  computeCardConviction,
} from "./card-finishing";
import { applyPostmortemAdjustments } from "./postmortem-adjustments";
import { getOrFetchBias, toBiasContext } from "./bias-fetcher";
import { enrichMaiden, type EnrichmentResult } from "./maiden-enrichment";
import { handicapRace, type HandoffConfig, type Handicap } from "./llm-handoff";
import { DEFAULT_WEIGHTS, type EeaWeights } from "./eea-config";
import type { BrisnetRace, EquibaseRace } from "./parsers/types";
import type { InsertRace } from "@shared/schema";

export interface AnalyzeInput {
  track: string;
  date: string;
  brisnetPath: string;
  equibasePath: string;
  brisnetFilename: string;
  equibaseFilename: string;
  provider?: "anthropic" | "poe";
}

export interface AnalyzeProgress {
  (step: string): void;
}

function loadHandoffConfig(provider?: "anthropic" | "poe"): HandoffConfig {
  const s = storage.getSettings();
  const active = storage.getActiveFormulaVersion();
  return {
    provider: provider ?? (s.defaultLlmProvider as "anthropic" | "poe"),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || s.anthropicApiKey,
    poeApiKey: process.env.POE_API_KEY || s.poeApiKey,
    anthropicModel: s.defaultAnthropicModel,
    poeModel: s.defaultPoeModel,
    persona: active?.personaText ?? "",
  };
}

function loadWeights(): EeaWeights {
  const active = storage.getActiveFormulaVersion();
  if (active?.weightsJson) {
    try {
      return JSON.parse(active.weightsJson) as EeaWeights;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_WEIGHTS;
}

// Build the flattened race-row picks from the LLM's ranked top4.
function picksFromHandicap(h: Handicap) {
  const [p1, p2, p3, p4] = [...h.top4].sort((a, b) => a.rank - b.rank);
  return {
    winPgm: p1?.pgm ?? null,
    winName: p1?.horseName ?? null,
    placePgm: p2?.pgm ?? null,
    placeName: p2?.horseName ?? null,
    showPgm: p3?.pgm ?? null,
    showName: p3?.horseName ?? null,
    fourthPgm: p4?.pgm ?? null,
    fourthName: p4?.horseName ?? null,
  };
}

export async function analyzeCard(
  input: AnalyzeInput,
  onProgress: AnalyzeProgress = () => {},
): Promise<{ cardId: number; racesAnalyzed: number; errors: string[] }> {
  const errors: string[] = [];

  onProgress("Parsing Brisnet PPs");
  const bris = await parseBrisnetPdf(input.brisnetPath, input.track, input.date);

  onProgress("Parsing Equibase speed figures");
  let equi: { races: EquibaseRace[] } = { races: [] };
  try {
    equi = await parseEquibasePdf(input.equibasePath, input.track, input.date);
  } catch (e) {
    errors.push(`Equibase parse failed: ${(e as Error).message}`);
  }

  // Index Equibase races by number for pairing with Brisnet.
  const equiByNum = new Map<number, EquibaseRace>();
  for (const r of equi.races) equiByNum.set(r.raceNumber, r);

  onProgress("Fetching prior-day track bias");
  const biasCard = await getOrFetchBias(input.track, input.date).catch(() => null);
  const biasCtx = toBiasContext(biasCard);

  // Create the (unpublished) card with empty race scaffolding first so we have
  // race ids to attach predictions to.
  const weights = loadWeights();
  const bankroll = storage.getSettings().bankroll;
  const activeVersion = storage.getActiveFormulaVersion();

  const cfg = loadHandoffConfig(input.provider);

  // Build per-race scaffolding (fusion happens up front; LLM per race below).
  const fusedRaces = bris.races.map((br: BrisnetRace) =>
    fuseRace(br, equiByNum.get(br.raceNumber), weights, biasCtx),
  );

  // Create the card with placeholder race rows (tier filled after LLM).
  const raceRowSeeds: Omit<InsertRace, "cardId">[] = fusedRaces.map((f) => ({
    raceNumber: f.raceNumber,
    tier: "PASS",
    conditions: cleanConditions(f.conditions.raw, {
      surface: f.conditions.surface,
      distance: f.conditions.distance,
      raceRating: equiByNum.get(f.raceNumber)?.raceRating ?? null,
    }),
    shape: f.shapeNote,
    flags: "[]",
  }));
  const card = storage.createCard(
    { track: input.track, date: input.date, locked: false },
    raceRowSeeds,
  );

  // Record the uploads.
  const now = new Date();
  storage.createPpUpload({
    cardId: card.id,
    source: "brisnet",
    filename: input.brisnetFilename,
    storagePath: input.brisnetPath,
    parsedJson: JSON.stringify(bris),
    parseStatus: "ok",
    parseError: null,
    uploadedAt: now,
  });
  storage.createPpUpload({
    cardId: card.id,
    source: "equibase",
    filename: input.equibaseFilename,
    storagePath: input.equibasePath,
    parsedJson: JSON.stringify(equi),
    parseStatus: errors.length ? "failed" : "ok",
    parseError: errors[0] ?? null,
    uploadedAt: now,
  });

  // Map raceNumber → race row id.
  const raceRows = storage.getRacesByCard(card.id);
  const raceIdByNum = new Map<number, number>();
  for (const r of raceRows) raceIdByNum.set(r.raceNumber, r.id);

  let analyzed = 0;
  const finalTiers: Tier[] = [];
  for (const fused of fusedRaces) {
    const raceId = raceIdByNum.get(fused.raceNumber);
    if (raceId == null) continue;

    // Maiden enrichment for maiden races.
    const maidens: EnrichmentResult[] = [];
    if (fused.raceType === "msw") {
      onProgress(`Enriching maidens (race ${fused.raceNumber})`);
      const brRace = bris.races.find((r) => r.raceNumber === fused.raceNumber);
      const eqRace = equiByNum.get(fused.raceNumber);
      for (const h of fused.horses) {
        const b = brRace?.horses.find((x) => x.pgm === h.pgm);
        const e = eqRace?.horses.find((x) => x.pgm === h.pgm);
        maidens.push(enrichMaiden(raceId, b, e));
      }
    }

    // Deterministic tier (advisory) before the LLM.
    const tierAssign = assignTier(fused, bankroll, weights);
    const tierByPgm = new Map(tierAssign.map((t) => [t.pgm, t]));

    onProgress(`Calling LLM (race ${fused.raceNumber})`);
    let handicap: Handicap | null = null;
    let provider = cfg.provider;
    let model = "";
    try {
      const res = await handicapRace({ fused, bias: biasCard, maidens }, cfg);
      handicap = res.handicap;
      provider = res.provider;
      model = res.model;
    } catch (e) {
      errors.push(`Race ${fused.raceNumber} LLM failed: ${(e as Error).message}`);
    }

    // Persist the race-level pick + tier.
    const flags = deriveFlags(fused, weights);
    if (handicap) {
      const rawPicks = picksFromHandicap(handicap);
      // Postmortem fixes (Card 1 Saratoga 2026-06-07): tighten EDGE class flips,
      // demote tier on flags hitting the win/place pick, co-top live longshots.
      const adj = applyPostmortemAdjustments(fused, handicap.tier as Tier, rawPicks, flags);
      const picks = adj.picks;
      const scores = scoresForPicks(fused, picks);
      const read = adj.coTopNote
        ? `${handicap.executiveSummary} — ${adj.coTopNote}`
        : handicap.executiveSummary;
      // Update the race row directly via storage (tier + picks + scores + read).
      storage.updateRaceFusion(raceId, {
        tier: adj.tier,
        read,
        flags: JSON.stringify(flags),
        tierDemotedBy: adj.tierDemotedBy,
        ...picks,
        ...scores,
      });
      finalTiers.push(adj.tier);
      analyzed++;
    } else {
      // No LLM: fall back to the deterministic tier + fused ranking so the card
      // still has populated scores and conditions instead of a blank PASS.
      const tierAssign = assignTier(fused, bankroll, weights);
      const ranked = [...fused.horses].sort((a, b) => a.rank - b.rank);
      const picks = {
        winPgm: ranked[0]?.pgm ?? null, winName: ranked[0]?.name ?? null,
        placePgm: ranked[1]?.pgm ?? null, placeName: ranked[1]?.name ?? null,
        showPgm: ranked[2]?.pgm ?? null, showName: ranked[2]?.name ?? null,
        fourthPgm: ranked[3]?.pgm ?? null, fourthName: ranked[3]?.name ?? null,
      };
      const leaderTier = (tierAssign.find((t) => t.pgm === ranked[0]?.pgm)?.tier ?? "PASS") as Tier;
      const adj = applyPostmortemAdjustments(fused, leaderTier, picks, flags);
      storage.updateRaceFusion(raceId, {
        tier: adj.tier,
        read: "LLM unavailable — review manually.",
        flags: JSON.stringify(flags),
        tierDemotedBy: adj.tierDemotedBy,
        ...adj.picks,
        ...scoresForPicks(fused, adj.picks),
      });
      finalTiers.push(adj.tier);
    }

    // Persist per-horse predictions (fused figures + LLM reasoning where ranked).
    const reasoningByPgm = new Map<string, { rank: number; why: string[]; pace: string }>();
    if (handicap) {
      for (const t of handicap.top4) {
        reasoningByPgm.set(t.pgm, { rank: t.rank, why: t.whyBullets, pace: t.paceMatchup });
      }
    }
    for (const h of fused.horses) {
      const r = reasoningByPgm.get(h.pgm);
      const t = tierByPgm.get(h.pgm);
      storage.createPrediction({
        raceId,
        horsePgm: h.pgm,
        horseName: h.name,
        eeas: h.eeas,
        eeap: h.eeapFit ?? h.eeap,
        eeac: h.eeac,
        eeaRating: h.eeaRating,
        tierAssigned: (r ? handicap?.tier : t?.tier) ?? "PASS",
        rank: r?.rank ?? h.rank,
        llmReasoning: r ? JSON.stringify({ why: r.why, paceMatchup: r.pace }) : null,
        personaVersion: activeVersion?.id ?? null,
        figureWeightsJson: JSON.stringify(weights),
        biasContextJson: biasCard ? JSON.stringify(biasCard) : null,
        llmProvider: provider,
        llmModel: model || null,
        createdAt: now,
      });
    }
  }

  // Card-level conviction from the per-race tiers.
  storage.updateCard(card.id, { cardConviction: computeCardConviction(finalTiers) });

  return { cardId: card.id, racesAnalyzed: analyzed, errors };
}
