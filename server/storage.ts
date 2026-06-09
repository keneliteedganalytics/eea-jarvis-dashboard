import {
  cards,
  races,
  results,
  settings,
  audioCache,
  ppUploads,
  predictions,
  predictionOutcomes,
  formulaVersions,
  tuningProposals,
  biasReads,
  maidenEnrichment,
  raceSummaries,
  voiceConversations,
  predictionHistory,
  cardShows,
  raceWeather,
  deepPostmortems,
  betLegs,
  raceEvents,
  cardSummaries,
} from "@shared/schema";
import type {
  Card,
  Race,
  Result,
  Settings,
  AudioCache,
  InsertCard,
  InsertRace,
  RaceWithResult,
  CardWithRaces,
  ArchivedCardsGrouped,
  PpUpload,
  InsertPpUpload,
  Prediction,
  InsertPrediction,
  PredictionOutcome,
  InsertPredictionOutcome,
  FormulaVersion,
  InsertFormulaVersion,
  TuningProposal,
  InsertTuningProposal,
  BiasRead,
  InsertBiasRead,
  MaidenEnrichment,
  InsertMaidenEnrichment,
  RaceSummary,
  InsertRaceSummary,
  RaceWeather,
  RaceWeatherRow,
  VoiceConversation,
  PredictionHistory,
  CardShow,
  ShowManifest,
  DeepPostmortemRow,
  DeepPostmortem,
  BetLegRow,
  RaceEventRow,
  CardSummaryRow,
  CardSummaryTier,
} from "@shared/schema";
import type { PedigreeSummary } from "@shared/schema";
import { db } from "./db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { gradeRace, gradeFlags } from "./grading";
import { DEFAULT_WEIGHTS, PERSONA_V1 } from "./services/eea-config";
import { buildWagers } from "./services/wagers";
import {
  buildBudgetedBets,
  configFromSettings,
  type RaceBets as BudgetedRaceBets,
} from "./services/budgeted-bets";
import { getBloodstockForCard } from "./services/brisnet-ingest";

export interface IStorage {
  // Cards
  getCards(): Card[];
  getActiveCards(): Card[];
  getCard(id: number): Card | undefined;
  getLatestCard(): CardWithRaces | undefined;
  getCardWithRaces(id: number): CardWithRaces | undefined;
  createCard(card: InsertCard, raceRows: Omit<InsertRace, "cardId">[]): CardWithRaces;
  updateCard(id: number, patch: Partial<Card>): Card | undefined;
  deleteCard(id: number): void;
  getLockedCards(): Card[];
  archiveCard(id: number, archivedAt: string): Card | undefined;
  getArchivedCardsGrouped(): ArchivedCardsGrouped;
  getArchivedCardById(id: number): CardWithRaces | undefined;

  // Races
  getRace(id: number): Race | undefined;
  getRacesByCard(cardId: number): Race[];
  updateRaceText(id: number, whyText?: string, paceText?: string): Race | undefined;
  updateRaceFusion(id: number, patch: Partial<Race>): Race | undefined;
  getRaceWeather(raceId: number): RaceWeather | null;
  upsertRaceWeather(raceId: number, w: RaceWeather): void;

  // Results
  getResultByRace(raceId: number): Result | undefined;
  logResult(raceId: number, finishOrder: string[], opts?: Partial<Result>): Result;
  updateResultPayouts(raceId: number, payouts: Partial<Result>): Result | undefined;

  // Bet ledger (PR #40)
  getBetLegsByCard(cardId: number): BetLegRow[];
  getAllBetLegs(): BetLegRow[];

  // Scratch + re-tier (PR #41)
  setHorseScratched(raceId: number, pgm: string, scratched: boolean): Race | undefined;
  reTier(raceId: number): Race | undefined;
  getRaceEvents(raceId: number): RaceEventRow[];

  // Card completion (PR #41)
  completeCard(cardId: number): CardSummaryRow | undefined;
  unlockCard(cardId: number): Card | undefined;
  getCardSummary(cardId: number): CardSummaryRow | undefined;

  // Settings
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  seedVoiceSettings(): void;

  // Audio cache
  getAudio(scriptHash: string): AudioCache | undefined;
  insertAudio(row: Omit<AudioCache, "id" | "createdAt">): AudioCache;

  // ── EEA v1 ────────────────────────────────────────────────────────────────
  // PP uploads
  createPpUpload(row: InsertPpUpload): PpUpload;
  updatePpUpload(id: number, patch: Partial<PpUpload>): PpUpload | undefined;
  getPpUploadsByCard(cardId: number): PpUpload[];

  // Predictions
  createPrediction(row: InsertPrediction): Prediction;
  updatePrediction(id: number, patch: Partial<Prediction>): Prediction | undefined;
  getPrediction(id: number): Prediction | undefined;
  getPredictionsByRace(raceId: number): Prediction[];
  getPredictionsByCard(cardId: number): Prediction[];
  deletePredictionsByCard(cardId: number): void;

  // Prediction outcomes
  upsertPredictionOutcome(row: InsertPredictionOutcome): PredictionOutcome;
  getOutcomeByPrediction(predictionId: number): PredictionOutcome | undefined;
  getAllPredictionsWithOutcomes(): { prediction: Prediction; outcome: PredictionOutcome | null }[];

  // Formula versions
  getActiveFormulaVersion(): FormulaVersion | undefined;
  createFormulaVersion(row: InsertFormulaVersion): FormulaVersion;
  activateFormulaVersion(weightsJson: string, personaText: string, notes?: string): FormulaVersion;

  // Tuning proposals
  createTuningProposal(row: InsertTuningProposal): TuningProposal;
  getPendingProposals(): TuningProposal[];
  updateProposalStatus(id: number, status: "accepted" | "rejected"): TuningProposal | undefined;

  // Bias reads
  upsertBiasRead(row: InsertBiasRead): BiasRead;
  getBiasRead(track: string, date: string): BiasRead | undefined;

  // Maiden enrichment
  upsertMaidenEnrichment(row: InsertMaidenEnrichment): MaidenEnrichment;
  getMaidenEnrichment(raceId: number, horsePgm: string): MaidenEnrichment | undefined;

  // Race summaries (print view, Anthropic-generated)
  getRaceSummary(raceId: number): RaceSummary | undefined;
  upsertRaceSummary(row: InsertRaceSummary & { raceId: number }): RaceSummary;

  // ── Voice subsystem ─────────────────────────────────────────────────────
  createVoiceConversation(row: {
    cardId: number;
    userTranscript: string;
    jarvisResponse: string;
    appliedChanges?: string | null;
    contextSummary?: string | null;
  }): VoiceConversation;
  getVoiceConversations(cardId: number): VoiceConversation[];
  getVoiceConversation(id: number): VoiceConversation | undefined;
  createVoiceConversationApplied(id: number, appliedChangesJson: string): void;
  markVoiceConversationReverted(id: number): void;
  getLastAppliedVoiceConversation(cardId: number): VoiceConversation | undefined;

  snapshotRace(
    cardId: number,
    raceId: number,
    trigger: "initial" | "voice_update" | "manual",
    voiceConversationId?: number,
  ): PredictionHistory;
  getLatestSnapshot(raceId: number): PredictionHistory | undefined;

  // ── Deep post-mortem (PR #25) ──────────────────────────────────────────────
  upsertDeepPostmortem(cardId: number, payload: DeepPostmortem): DeepPostmortemRow;
  getDeepPostmortem(cardId: number): DeepPostmortem | null;
}

// Tolerant JSON string-array parse for columns like races.scratched_pgms /
// races.flags. Never throws — a malformed value resolves to an empty array.
function parseStringArrayField(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Map a persisted race_weather row to the RaceWeather API/engine shape.
function rowToRaceWeather(row: RaceWeatherRow): RaceWeather {
  return {
    tempF: row.tempF,
    feelsLikeF: row.feelsLikeF,
    conditions: row.conditions,
    precipMm: row.precipMm,
    windMph: row.windMph,
    windDirDeg: row.windDirDeg,
    humidityPct: row.humidityPct,
    surfaceImpact: row.surfaceImpact as RaceWeather["surfaceImpact"],
    fetchedAt: row.fetchedAt,
    source: "openweather",
  };
}

export class DatabaseStorage implements IStorage {
  // ── Cards ───────────────────────────────────────────────────────────────
  getCards(): Card[] {
    return db.select().from(cards).all();
  }

  getCard(id: number): Card | undefined {
    return db.select().from(cards).where(eq(cards.id, id)).get();
  }

  private withRaces(card: Card): CardWithRaces {
    const raceRows = db
      .select()
      .from(races)
      .where(eq(races.cardId, card.id))
      .all()
      .sort((a, b) => a.raceNumber - b.raceNumber);
    // Build Suggested Wagers from the single source of truth so every surface
    // (Race Detail, Print) renders identical numbers off the same race rows.
    const s = this.getSettings();
    const racesOnCard = raceRows.length;

    // PR #40: NEW cards (betBudgetVersion >= 2) use the tier-weighted $1k
    // BudgetedBetBuilder, computed across the whole card. Historical cards
    // (version 1, e.g. Card #4) keep their legacy flat bets AS-IS.
    const useBudgeted = (card.betBudgetVersion ?? 1) >= 2;
    const budgetedByRace: Map<number, BudgetedRaceBets> | null = useBudgeted
      ? buildBudgetedBets(raceRows, configFromSettings(s))
      : null;

    // DRM pedigree names for this card (race#|pgm → sire/dam/dam-sire), used to
    // enrich the bloodstock chip's tooltip. Empty when the card was never
    // DRM-ingested, in which case the chip falls back to confidence "none".
    const pedigreeNames = getBloodstockForCard(card.date, card.track);
    const withResults: RaceWithResult[] = raceRows.map((r) => {
      const bets = budgetedByRace
        ? budgetedByRace.get(r.id) ?? { tier: r.tier as any, raceAllocation: 0, pass: true, legs: [] }
        : buildWagers(r, { bankroll: s.bankroll, dailyRiskCapPct: s.dailyRiskCapPct }, racesOnCard);
      return {
        ...r,
        result: this.getResultByRace(r.id) ?? null,
        bets,
        weather: this.getRaceWeather(r.id),
        pedigree: this.buildPedigree(r.id, r.raceNumber, pedigreeNames),
        events: this.getRaceEvents(r.id),
      };
    });

    // Lazily persist the bet_legs ledger the first time a race is read with bets
    // and has no ledger rows yet. Idempotent: once rows exist for a race we never
    // re-write them, so payouts/hits entered later are preserved.
    this.ensureLedgerForCard(card.id, withResults);

    return { ...card, races: withResults };
  }

  // Write one bet_legs row per leg for any race on this card that has bets but
  // no ledger rows yet. Costs come from the (budgeted or flat) bets; payout/hit
  // start null and are filled in on payouts entry. This is both the live
  // persistence path for new cards and the boot backfill for historical cards.
  private ensureLedgerForCard(cardId: number, racesWithBets: RaceWithResult[]): void {
    for (const r of racesWithBets) {
      const legs = r.bets?.legs ?? [];
      if (legs.length === 0) continue;
      const existing = db
        .select({ id: betLegs.id })
        .from(betLegs)
        .where(eq(betLegs.raceId, r.id))
        .all();
      if (existing.length > 0) continue;
      const flagsJson = r.flags || "[]";
      for (const leg of legs) {
        db.insert(betLegs)
          .values({
            raceId: r.id,
            cardId,
            tier: r.bets?.tier ?? r.tier,
            legType: leg.type,
            structure: leg.structure,
            cost: leg.cost,
            payout: null,
            hit: null,
            flagsJson,
          })
          .run();
      }
      // If the race is already graded, immediately reconcile hit/payout so the
      // ledger reflects known outcomes without waiting for a re-grade.
      if (r.result) this.applyResultToLedger(r.id, r.result);
    }
  }

  // Build the per-program pedigree summaries the bloodstock chip renders, keyed
  // by program number. Reads each prediction's bloodstockJson (the fusion
  // engine's BloodstockAdjustment) and enriches it with sire/dam/dam-sire names
  // from the DRM ingest. Races with no predictions or no bloodstockJson simply
  // omit those horses; a missing DRM card leaves names null.
  private buildPedigree(
    raceId: number,
    raceNumber: number,
    pedigreeNames: ReturnType<typeof getBloodstockForCard>,
  ): Record<string, PedigreeSummary> {
    const out: Record<string, PedigreeSummary> = {};
    for (const p of this.getPredictionsByRace(raceId)) {
      if (!p.bloodstockJson) continue;
      let adj: {
        applied?: boolean;
        composite?: number;
        confidence?: PedigreeSummary["confidence"];
        reasonCodes?: string[];
      };
      try {
        adj = JSON.parse(p.bloodstockJson);
      } catch {
        continue;
      }
      const names = pedigreeNames.get(`${raceNumber}|${p.horsePgm}`);
      out[p.horsePgm] = {
        composite: adj.composite ?? 50,
        confidence: adj.confidence ?? "none",
        applied: adj.applied ?? false,
        reasonCodes: adj.reasonCodes ?? [],
        sireName: names?.sireName ?? null,
        damName: names?.damName ?? null,
        damSireName: names?.damSireName ?? null,
      };
    }
    return out;
  }

  getLatestCard(): CardWithRaces | undefined {
    const all = db.select().from(cards).all();
    if (!all.length) return undefined;
    const latest = all.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return this.withRaces(latest);
  }

  getCardWithRaces(id: number): CardWithRaces | undefined {
    const card = this.getCard(id);
    if (!card) return undefined;
    return this.withRaces(card);
  }

  createCard(
    card: InsertCard,
    raceRows: Omit<InsertRace, "cardId">[],
  ): CardWithRaces {
    const created = db.insert(cards).values(card).returning().get();
    for (const r of raceRows) {
      db.insert(races).values({ ...r, cardId: created.id }).run();
    }
    return this.withRaces(created);
  }

  updateCard(id: number, patch: Partial<Card>): Card | undefined {
    db.update(cards).set(patch).where(eq(cards.id, id)).run();
    return this.getCard(id);
  }

  deleteCard(id: number): void {
    db.delete(betLegs).where(eq(betLegs.cardId, id)).run();
    db.delete(ppUploads).where(eq(ppUploads.cardId, id)).run();
    db.delete(races).where(eq(races.cardId, id)).run();
    db.delete(cards).where(eq(cards.id, id)).run();
  }

  getLockedCards(): Card[] {
    return db.select().from(cards).where(eq(cards.locked, true)).all();
  }

  // ── Archive ───────────────────────────────────────────────────────────────
  getActiveCards(): Card[] {
    return db.select().from(cards).where(eq(cards.status, "active")).all();
  }

  archiveCard(id: number, archivedAt: string): Card | undefined {
    db.update(cards)
      .set({ status: "archived", archivedAt })
      .where(eq(cards.id, id))
      .run();
    return this.getCard(id);
  }

  // All archived cards, grouped by track. Tracks sorted A→Z; cards within a
  // track sorted by race date DESC (newest first).
  getArchivedCardsGrouped(): ArchivedCardsGrouped {
    const archived = db
      .select()
      .from(cards)
      .where(eq(cards.status, "archived"))
      .all();
    const byTrack = new Map<string, typeof archived>();
    for (const c of archived) {
      const list = byTrack.get(c.track) ?? [];
      list.push(c);
      byTrack.set(c.track, list);
    }
    const tracks = Array.from(byTrack.keys()).sort((a, b) => a.localeCompare(b)).map((track) => {
      const list = byTrack
        .get(track)!
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return {
        track,
        cards: list.map((c) => ({
          id: c.id,
          date: c.date,
          raceCount: this.getRacesByCard(c.id).length,
          cardConviction: c.cardConviction,
          archivedAt: c.archivedAt,
        })),
      };
    });
    return { tracks };
  }

  getArchivedCardById(id: number): CardWithRaces | undefined {
    const card = this.getCard(id);
    if (!card || card.status !== "archived") return undefined;
    return this.withRaces(card);
  }

  // ── Races ───────────────────────────────────────────────────────────────
  getRace(id: number): Race | undefined {
    return db.select().from(races).where(eq(races.id, id)).get();
  }

  getRacesByCard(cardId: number): Race[] {
    return db.select().from(races).where(eq(races.cardId, cardId)).all();
  }

  // ── Race weather (PR #18) ─────────────────────────────────────────────────
  getRaceWeather(raceId: number): RaceWeather | null {
    const row = db
      .select()
      .from(raceWeather)
      .where(eq(raceWeather.raceId, raceId))
      .get();
    return row ? rowToRaceWeather(row) : null;
  }

  upsertRaceWeather(raceId: number, w: RaceWeather): void {
    const values = {
      raceId,
      tempF: w.tempF,
      feelsLikeF: w.feelsLikeF,
      conditions: w.conditions,
      precipMm: w.precipMm,
      windMph: w.windMph,
      windDirDeg: w.windDirDeg,
      humidityPct: w.humidityPct,
      surfaceImpact: w.surfaceImpact,
      source: w.source,
      fetchedAt: w.fetchedAt,
    };
    db.insert(raceWeather)
      .values(values)
      .onConflictDoUpdate({ target: raceWeather.raceId, set: values })
      .run();
  }

  updateRaceText(id: number, whyText?: string, paceText?: string): Race | undefined {
    const patch: Partial<Race> = {};
    if (whyText !== undefined) patch.whyText = whyText;
    if (paceText !== undefined) patch.paceText = paceText;
    db.update(races).set(patch).where(eq(races.id, id)).run();
    return this.getRace(id);
  }

  // Apply fused/LLM results to a race row (tier, read, flattened picks).
  updateRaceFusion(id: number, patch: Partial<Race>): Race | undefined {
    db.update(races).set(patch).where(eq(races.id, id)).run();
    return this.getRace(id);
  }

  // ── Results ─────────────────────────────────────────────────────────────
  getResultByRace(raceId: number): Result | undefined {
    return db.select().from(results).where(eq(results.raceId, raceId)).get();
  }

  logResult(raceId: number, finishOrder: string[], opts: Partial<Result> = {}): Result {
    const race = this.getRace(raceId);
    if (!race) throw new Error(`Race ${raceId} not found`);
    const graded = gradeRace(race, finishOrder);
    const flagsHit = gradeFlags(race, finishOrder);

    // Remove existing result so this acts as upsert
    db.delete(results).where(eq(results.raceId, raceId)).run();

    const row = db
      .insert(results)
      .values({
        raceId,
        finishOrder: JSON.stringify(finishOrder),
        winHit: graded.winHit,
        placeHit: graded.placeHit,
        showHit: graded.showHit,
        fourthHit: graded.fourthHit,
        itmCount: graded.itmCount,
        exactaHit: graded.exactaHit,
        trifectaHit: graded.trifectaHit,
        superfectaHit: graded.superfectaHit,
        flagsHit: JSON.stringify(flagsHit),
        autoFetched: opts.autoFetched ?? false,
        winOdds: opts.winOdds ?? null,
        winPayout: opts.winPayout ?? null,
        placePayout: opts.placePayout ?? null,
        showPayout: opts.showPayout ?? null,
        exactaPayout: opts.exactaPayout ?? null,
        trifectaPayout: opts.trifectaPayout ?? null,
        superfectaPayout: opts.superfectaPayout ?? null,
        payoutsRaw: opts.payoutsRaw ?? null,
      })
      .returning()
      .get();
    // Reconcile the bet_legs ledger with this grade + any payouts entered.
    this.applyResultToLedger(raceId, row);
    return row;
  }

  // Backfill payouts (and/or win odds) onto an already-graded race without
  // re-entering the finish order. Works on ANY graded card, including past ones
  // (e.g. Card #4) the user is backfilling from chart data. Re-reconciles the
  // ledger so per-leg payout/hit reflect the new numbers.
  updateResultPayouts(raceId: number, payouts: Partial<Result>): Result | undefined {
    const existing = this.getResultByRace(raceId);
    if (!existing) return undefined;
    const patch: Partial<Result> = {};
    const keys: (keyof Result)[] = [
      "winOdds", "winPayout", "placePayout", "showPayout",
      "exactaPayout", "trifectaPayout", "superfectaPayout",
    ];
    for (const k of keys) {
      if (k in payouts) (patch as any)[k] = (payouts as any)[k] ?? null;
    }
    db.update(results).set(patch).where(eq(results.raceId, raceId)).run();
    const row = this.getResultByRace(raceId);
    if (row) this.applyResultToLedger(raceId, row);
    return row;
  }

  // ── Bet ledger (PR #40) ───────────────────────────────────────────────────
  getBetLegsByCard(cardId: number): BetLegRow[] {
    return db.select().from(betLegs).where(eq(betLegs.cardId, cardId)).all();
  }

  getAllBetLegs(): BetLegRow[] {
    return db.select().from(betLegs).all();
  }

  // Set hit + payout on each ledger leg for a race from its result row. Per-leg
  // payout is computed off the $2-base payoff: leg won → (cost / 2) * payout.
  // Legs whose position the pick missed get hit=false, payout=0. When a payoff
  // wasn't entered the leg is marked hit but payout stays null (unknown return).
  private applyResultToLedger(raceId: number, result: Result): void {
    // Refunded legs (PR #41) are settled — they were refunded when the race was
    // re-tiered after a scratch, so they must NOT be re-graded against the new
    // finish order. Only reconcile the live (non-refunded) legs.
    const legs = db
      .select()
      .from(betLegs)
      .where(and(eq(betLegs.raceId, raceId), eq(betLegs.refunded, false)))
      .all();
    if (legs.length === 0) return;
    const hitForLeg = (legType: string): boolean | null => {
      switch (legType) {
        case "WIN": return result.winHit ?? null;
        case "PLACE": return result.placeHit ?? null;
        case "SHOW": return result.showHit ?? null;
        case "EXACTA": return result.exactaHit ?? null;
        case "TRIFECTA": return result.trifectaHit ?? null;
        case "SUPERFECTA": return result.superfectaHit ?? null;
        default: return null;
      }
    };
    const payoutForLeg = (legType: string): number | null => {
      switch (legType) {
        case "WIN": return result.winPayout ?? null;
        case "PLACE": return result.placePayout ?? null;
        case "SHOW": return result.showPayout ?? null;
        case "EXACTA": return result.exactaPayout ?? null;
        case "TRIFECTA": return result.trifectaPayout ?? null;
        case "SUPERFECTA": return result.superfectaPayout ?? null;
        default: return null;
      }
    };
    for (const leg of legs) {
      const hit = hitForLeg(leg.legType);
      let payout: number | null = null;
      if (hit === true) {
        const payoff = payoutForLeg(leg.legType);
        // Per spec: leg payout = (cost / 2) * payoff. Null payoff → unknown return.
        payout = payoff != null ? Math.round((leg.cost / 2) * payoff * 100) / 100 : null;
      } else if (hit === false) {
        payout = 0;
      }
      db.update(betLegs).set({ hit, payout }).where(eq(betLegs.id, leg.id)).run();
    }
  }

  // ── Scratch + re-tier (PR #41) ────────────────────────────────────────────
  // Toggle a horse's scratched state for a race, then re-tier. The race's
  // scratched_pgms JSON array is the authoritative per-race scratch set (there
  // is no horses table). We also flip the matching prediction row's scratched
  // flag (when one exists) so the rating-based re-rank in reTier() and the
  // existing scratch-refresh path agree. Idempotent: scratching an already-
  // scratched pgm (or un-scratching a clean one) is a no-op beyond re-tiering.
  setHorseScratched(raceId: number, pgm: string, scratched: boolean): Race | undefined {
    const race = this.getRace(raceId);
    if (!race) return undefined;
    const current = parseStringArrayField(race.scratchedPgms);
    const set = new Set(current);
    if (scratched) set.add(pgm);
    else set.delete(pgm);
    db.update(races)
      .set({ scratchedPgms: JSON.stringify(Array.from(set)) })
      .where(eq(races.id, raceId))
      .run();
    // Keep prediction-level flag in sync where a prediction exists for this pgm.
    const nowIso = new Date().toISOString();
    const pred = this.getPredictionsByRace(raceId).find((p) => p.horsePgm === pgm);
    if (pred) {
      this.updatePrediction(pred.id, {
        scratched,
        scratchedAt: scratched ? nowIso : null,
      });
    }
    return this.reTier(raceId);
  }

  // Re-rank a race's surviving (non-scratched) runners into Win/Place/Show/4th,
  // rebuild this race's budgeted bets + ledger (refunding the OLD legs), and log
  // a SCRATCH race_event. Pure re-tier of ONE race; the rest of the card's bets
  // are untouched (each race's budget is independent in the allocator). Safe to
  // call repeatedly — refunds are keyed on the live legs, so a re-tier always
  // refunds whatever is currently live and writes a fresh live set.
  reTier(raceId: number): Race | undefined {
    const race = this.getRace(raceId);
    if (!race) return undefined;
    const card = this.getCard(race.cardId);
    if (!card) return race;

    const scratched = new Set(parseStringArrayField(race.scratchedPgms));
    const oldPicks = {
      win: race.winPgm, place: race.placePgm, show: race.showPgm, fourth: race.fourthPgm,
    };

    // Build the new ranked pick order from surviving runners.
    const round1 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 10) / 10);
    const preds = this.getPredictionsByRace(raceId).filter(
      (p) => p.eeaRating != null && !scratched.has(p.horsePgm) && !p.scratched,
    );
    let picksPatch: Partial<Race>;
    if (preds.length > 0) {
      // Rating-based re-rank (best signal). Mirrors recomputeTierIfNeeded.
      const survivors = preds.sort(
        (a, b) => (b.eeaRating ?? -Infinity) - (a.eeaRating ?? -Infinity),
      );
      const s = (i: number) => survivors[i];
      picksPatch = {
        winPgm: s(0)?.horsePgm ?? null, winName: s(0)?.horseName ?? null, winScore: round1(s(0)?.eeaRating),
        placePgm: s(1)?.horsePgm ?? null, placeName: s(1)?.horseName ?? null, placeScore: round1(s(1)?.eeaRating),
        showPgm: s(2)?.horsePgm ?? null, showName: s(2)?.horseName ?? null, showScore: round1(s(2)?.eeaRating),
        fourthPgm: s(3)?.horsePgm ?? null, fourthName: s(3)?.horseName ?? null, fourthScore: round1(s(3)?.eeaRating),
      };
    } else {
      // No predictions (manual-ingest card): there's no rating to re-rank by, so
      // we restore from a one-time BASELINE snapshot of the original four picks.
      // The baseline is captured the first time this race is ever re-tiered (when
      // the picks are still pristine) and never overwritten, so every subsequent
      // scratch/un-scratch is just "baseline filtered by the current scratch set"
      // — making un-scratch fully reversible even on prediction-less cards.
      const baseline = this.ensurePickBaseline(raceId, race);
      const slots = baseline.filter((p) => p.pgm && !scratched.has(p.pgm));
      const s = (i: number) => slots[i];
      picksPatch = {
        winPgm: s(0)?.pgm ?? null, winName: s(0)?.name ?? null, winScore: s(0)?.score ?? null,
        placePgm: s(1)?.pgm ?? null, placeName: s(1)?.name ?? null, placeScore: s(1)?.score ?? null,
        showPgm: s(2)?.pgm ?? null, showName: s(2)?.name ?? null, showScore: s(2)?.score ?? null,
        fourthPgm: s(3)?.pgm ?? null, fourthName: s(3)?.name ?? null, fourthScore: s(3)?.score ?? null,
      };
    }
    db.update(races).set(picksPatch).where(eq(races.id, raceId)).run();

    // Rebuild this race's bets + ledger. Refund the currently-live legs first.
    this.rebuildRaceLedger(race.cardId, raceId, card.betBudgetVersion ?? 1);

    // Log the SCRATCH event with the old/new pick diff for the history panel.
    const fresh = this.getRace(raceId)!;
    const newPicks = {
      win: fresh.winPgm, place: fresh.placePgm, show: fresh.showPgm, fourth: fresh.fourthPgm,
    };
    db.insert(raceEvents)
      .values({
        raceId,
        type: scratched.size > 0 ? "SCRATCH" : "UNSCRATCH",
        payloadJson: JSON.stringify({
          scratched: Array.from(scratched),
          reTieredAt: new Date().toISOString(),
          oldPicks,
          newPicks,
        }),
      })
      .run();
    return fresh;
  }

  // Return the pristine original four picks for a prediction-less race, captured
  // once as a BASELINE race_event the first time the race is re-tiered. On the
  // first call the current (still-pristine) picks are snapshotted; thereafter the
  // stored snapshot is returned verbatim so scratch/un-scratch is reversible.
  private ensurePickBaseline(
    raceId: number,
    race: Race,
  ): { pgm: string | null; name: string | null; score: number | null }[] {
    const existing = db
      .select()
      .from(raceEvents)
      .where(and(eq(raceEvents.raceId, raceId), eq(raceEvents.type, "BASELINE")))
      .get();
    if (existing) {
      try {
        const slots = JSON.parse(existing.payloadJson || "[]");
        if (Array.isArray(slots)) return slots;
      } catch {
        /* fall through to re-snapshot */
      }
    }
    const slots = [
      { pgm: race.winPgm, name: race.winName, score: race.winScore },
      { pgm: race.placePgm, name: race.placeName, score: race.placeScore },
      { pgm: race.showPgm, name: race.showName, score: race.showScore },
      { pgm: race.fourthPgm, name: race.fourthName, score: race.fourthScore },
    ];
    db.insert(raceEvents)
      .values({ raceId, type: "BASELINE", payloadJson: JSON.stringify(slots) })
      .run();
    return slots;
  }

  // Refund this race's live bet_legs and write a fresh live set from the rebuilt
  // bets. Old legs are marked refunded (not deleted) so ROI excludes their cost
  // without counting them as losses, and the audit trail survives. New legs are
  // reconciled against the result if the race is already graded.
  private rebuildRaceLedger(cardId: number, raceId: number, betBudgetVersion: number): void {
    const nowIso = new Date().toISOString();
    db.update(betLegs)
      .set({ refunded: true, scratchedAt: nowIso })
      .where(and(eq(betLegs.raceId, raceId), eq(betLegs.refunded, false)))
      .run();

    const race = this.getRace(raceId);
    if (!race) return;
    const s = this.getSettings();
    let bets: BudgetedRaceBets | undefined;
    if ((betBudgetVersion ?? 1) >= 2) {
      bets = buildBudgetedBets([race], configFromSettings(s)).get(raceId);
    } else {
      const racesOnCard = this.getRacesByCard(cardId).length;
      bets = buildWagers(
        race,
        { bankroll: s.bankroll, dailyRiskCapPct: s.dailyRiskCapPct },
        racesOnCard,
      ) as unknown as BudgetedRaceBets;
    }
    const legs = bets?.legs ?? [];
    const flagsJson = race.flags || "[]";
    for (const leg of legs) {
      db.insert(betLegs)
        .values({
          raceId,
          cardId,
          tier: bets?.tier ?? race.tier,
          legType: leg.type,
          structure: leg.structure,
          cost: leg.cost,
          payout: null,
          hit: null,
          flagsJson,
          refunded: false,
        })
        .run();
    }
    const result = this.getResultByRace(raceId);
    if (result) this.applyResultToLedger(raceId, result);
  }

  getRaceEvents(raceId: number): RaceEventRow[] {
    return db
      .select()
      .from(raceEvents)
      .where(eq(raceEvents.raceId, raceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ── Card completion (PR #41) ──────────────────────────────────────────────
  // Freeze a card: flip status→completed, stamp completedAt, and write the
  // frozen ROI roll-up to card_summaries. Read-only enforcement (rejecting
  // grading/payouts) lives at the route layer. Idempotent: re-completing
  // recomputes the summary off the current ledger.
  completeCard(cardId: number): CardSummaryRow | undefined {
    const card = this.getCard(cardId);
    if (!card) return undefined;
    // Materialize the ledger for this card so the roll-up sees every leg.
    this.getCardWithRaces(cardId);
    db.update(cards)
      .set({ status: "completed", completedAt: new Date().toISOString(), locked: true })
      .where(eq(cards.id, cardId))
      .run();
    return this.computeCardSummary(cardId);
  }

  // Re-enable editing on a completed card (Settings admin escape hatch). Returns
  // the card to "active"; the frozen card_summaries row is left in place until
  // the card is completed again (which recomputes it).
  unlockCard(cardId: number): Card | undefined {
    const card = this.getCard(cardId);
    if (!card) return undefined;
    db.update(cards)
      .set({ status: "active", completedAt: null })
      .where(eq(cards.id, cardId))
      .run();
    return this.getCard(cardId);
  }

  getCardSummary(cardId: number): CardSummaryRow | undefined {
    return db.select().from(cardSummaries).where(eq(cardSummaries.cardId, cardId)).get();
  }

  // Aggregate the card's live (non-refunded), settled ledger into a frozen
  // summary. ROI% = (payout - cost) / cost over settled legs. Win/ITM rates come
  // off graded race rows. Upserts the card_summaries row.
  private computeCardSummary(cardId: number): CardSummaryRow {
    const legs = this.getBetLegsByCard(cardId).filter((l) => !l.refunded && l.hit !== null);
    const totalCost = legs.reduce((a, l) => a + l.cost, 0);
    const totalPayout = legs.reduce((a, l) => a + (l.payout ?? 0), 0);
    const roiPct =
      totalCost > 0 ? Math.round(((totalPayout - totalCost) / totalCost) * 1000) / 10 : null;

    const raceRows = this.getRacesByCard(cardId);
    const graded = raceRows
      .map((r) => this.getResultByRace(r.id))
      .filter((r): r is Result => !!r);
    const winHits = graded.filter((r) => r.winHit).length;
    const winRate = graded.length > 0 ? Math.round((winHits / graded.length) * 1000) / 10 : null;
    const itmSlots = graded.reduce((a, r) => a + (r.itmCount ?? 0), 0);
    const itmRate =
      graded.length > 0 ? Math.round((itmSlots / (graded.length * 4)) * 1000) / 10 : null;

    // Per-tier breakdown off the same settled, live legs.
    const tierMap = new Map<string, CardSummaryTier>();
    for (const l of legs) {
      const t = tierMap.get(l.tier) ?? { tier: l.tier, cost: 0, payout: 0, roi: null, legs: 0 };
      t.cost += l.cost;
      t.payout += l.payout ?? 0;
      t.legs += 1;
      tierMap.set(l.tier, t);
    }
    const tierBreakdown = Array.from(tierMap.values()).map((t) => ({
      ...t,
      cost: Math.round(t.cost * 100) / 100,
      payout: Math.round(t.payout * 100) / 100,
      roi: t.cost > 0 ? Math.round(((t.payout - t.cost) / t.cost) * 1000) / 10 : null,
    }));

    const row = {
      cardId,
      totalCost: Math.round(totalCost * 100) / 100,
      totalPayout: Math.round(totalPayout * 100) / 100,
      roiPct,
      winRate,
      itmRate,
      tierBreakdownJson: JSON.stringify(tierBreakdown),
      computedAt: new Date().toISOString(),
    };
    db.insert(cardSummaries)
      .values(row)
      .onConflictDoUpdate({ target: cardSummaries.cardId, set: row })
      .run();
    return db.select().from(cardSummaries).where(eq(cardSummaries.cardId, cardId)).get()!;
  }

  // ── Daily Show ──────────────────────────────────────────────────────────
  getCardShow(cardId: number): CardShow | undefined {
    return db.select().from(cardShows).where(eq(cardShows.cardId, cardId)).get();
  }

  // Mark a card's show as building (or re-building). Clears any prior error and
  // manifest so a stale-state read never looks ready mid-rebuild.
  startCardShow(cardId: number): CardShow {
    const now = new Date().toISOString();
    db.delete(cardShows).where(eq(cardShows.cardId, cardId)).run();
    return db
      .insert(cardShows)
      .values({ cardId, status: "building", startedAt: now, completedAt: null, error: null, manifestJson: null })
      .returning()
      .get();
  }

  // Mark a card's show as requested: the build happens out-of-band in Computer,
  // which polls for this state, generates the clips, and POSTs them back. Clears
  // any prior error/manifest so a stale read never looks ready while requested.
  requestCardShow(cardId: number): CardShow {
    const now = new Date().toISOString();
    db.delete(cardShows).where(eq(cardShows.cardId, cardId)).run();
    return db
      .insert(cardShows)
      .values({ cardId, status: "requested", startedAt: now, completedAt: null, error: null, manifestJson: null })
      .returning()
      .get();
  }

  // Mark ready with the built manifest. Upserts so a direct upload (no prior
  // requested/building row, e.g. Computer posting clips out-of-band) still
  // persists; when a row already exists the timestamps/status are updated.
  completeCardShow(cardId: number, manifest: ShowManifest): CardShow | undefined {
    const now = new Date().toISOString();
    const manifestJson = JSON.stringify(manifest);
    const updated = db
      .update(cardShows)
      .set({ status: "ready", manifestJson, completedAt: now, error: null })
      .where(eq(cardShows.cardId, cardId))
      .run();
    if (updated.changes === 0) {
      db.insert(cardShows)
        .values({ cardId, status: "ready", manifestJson, startedAt: now, completedAt: now, error: null })
        .run();
    }
    return this.getCardShow(cardId);
  }

  failCardShow(cardId: number, error: string): CardShow | undefined {
    db.update(cardShows)
      .set({ status: "error", error: error.slice(0, 1000), completedAt: new Date().toISOString() })
      .where(eq(cardShows.cardId, cardId))
      .run();
    return this.getCardShow(cardId);
  }

  deleteCardShow(cardId: number): void {
    db.delete(cardShows).where(eq(cardShows.cardId, cardId)).run();
  }

  // ── Settings ────────────────────────────────────────────────────────────
  getSettings(): Settings {
    let row = db.select().from(settings).get();
    if (!row) {
      row = db.insert(settings).values({}).returning().get();
    }
    return row;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const current = this.getSettings();
    db.update(settings).set(patch).where(eq(settings.id, current.id)).run();
    return this.getSettings();
  }

  // PR #22: idempotently seed the two voice ids from env on boot. Only writes a
  // value the operator explicitly provided via env (ELEVENLABS_VOICE_JARVIS /
  // ELEVENLABS_VOICE_SCARLETT); otherwise the existing stored value (or the
  // column default) stands. Safe to call every boot.
  seedVoiceSettings(): void {
    const s = this.getSettings();
    const patch: Partial<Settings> = {};
    const jarvis = process.env.ELEVENLABS_VOICE_JARVIS;
    const scarlett = process.env.ELEVENLABS_VOICE_SCARLETT;
    if (jarvis && jarvis !== s.elevenlabsVoiceId) patch.elevenlabsVoiceId = jarvis;
    if (scarlett && scarlett !== s.elevenlabsVoiceIdScarlett) {
      patch.elevenlabsVoiceIdScarlett = scarlett;
    }
    if (Object.keys(patch).length) this.updateSettings(patch);
  }

  // ── Audio cache ─────────────────────────────────────────────────────────
  getAudio(scriptHash: string): AudioCache | undefined {
    return db
      .select()
      .from(audioCache)
      .where(eq(audioCache.scriptHash, scriptHash))
      .get();
  }

  insertAudio(row: Omit<AudioCache, "id" | "createdAt">): AudioCache {
    return db.insert(audioCache).values(row).returning().get();
  }

  // ── EEA v1: PP uploads ────────────────────────────────────────────────────
  createPpUpload(row: InsertPpUpload): PpUpload {
    return db.insert(ppUploads).values(row).returning().get();
  }

  updatePpUpload(id: number, patch: Partial<PpUpload>): PpUpload | undefined {
    db.update(ppUploads).set(patch).where(eq(ppUploads.id, id)).run();
    return db.select().from(ppUploads).where(eq(ppUploads.id, id)).get();
  }

  getPpUploadsByCard(cardId: number): PpUpload[] {
    return db.select().from(ppUploads).where(eq(ppUploads.cardId, cardId)).all();
  }

  // ── EEA v1: predictions ───────────────────────────────────────────────────
  createPrediction(row: InsertPrediction): Prediction {
    return db.insert(predictions).values(row).returning().get();
  }

  updatePrediction(id: number, patch: Partial<Prediction>): Prediction | undefined {
    db.update(predictions).set(patch).where(eq(predictions.id, id)).run();
    return this.getPrediction(id);
  }

  getPrediction(id: number): Prediction | undefined {
    return db.select().from(predictions).where(eq(predictions.id, id)).get();
  }

  getPredictionsByRace(raceId: number): Prediction[] {
    return db
      .select()
      .from(predictions)
      .where(eq(predictions.raceId, raceId))
      .all()
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  }

  getPredictionsByCard(cardId: number): Prediction[] {
    const raceRows = db.select().from(races).where(eq(races.cardId, cardId)).all();
    const ids = new Set(raceRows.map((r) => r.id));
    return db
      .select()
      .from(predictions)
      .all()
      .filter((p) => ids.has(p.raceId));
  }

  deletePredictionsByCard(cardId: number): void {
    const raceRows = db.select().from(races).where(eq(races.cardId, cardId)).all();
    for (const r of raceRows) {
      db.delete(predictions).where(eq(predictions.raceId, r.id)).run();
    }
  }

  // ── EEA v1: prediction outcomes ───────────────────────────────────────────
  upsertPredictionOutcome(row: InsertPredictionOutcome): PredictionOutcome {
    db.delete(predictionOutcomes)
      .where(eq(predictionOutcomes.predictionId, row.predictionId))
      .run();
    return db.insert(predictionOutcomes).values(row).returning().get();
  }

  getOutcomeByPrediction(predictionId: number): PredictionOutcome | undefined {
    return db
      .select()
      .from(predictionOutcomes)
      .where(eq(predictionOutcomes.predictionId, predictionId))
      .get();
  }

  getAllPredictionsWithOutcomes(): { prediction: Prediction; outcome: PredictionOutcome | null }[] {
    const preds = db.select().from(predictions).all();
    return preds.map((p) => ({
      prediction: p,
      outcome: this.getOutcomeByPrediction(p.id) ?? null,
    }));
  }

  // ── EEA v1: formula versions ──────────────────────────────────────────────
  getActiveFormulaVersion(): FormulaVersion | undefined {
    return db
      .select()
      .from(formulaVersions)
      .where(isNull(formulaVersions.deactivatedAt))
      .all()
      .sort((a, b) => b.id - a.id)[0];
  }

  createFormulaVersion(row: InsertFormulaVersion): FormulaVersion {
    return db.insert(formulaVersions).values(row).returning().get();
  }

  activateFormulaVersion(weightsJson: string, personaText: string, notes?: string): FormulaVersion {
    const now = new Date();
    // Deactivate the current active version.
    db.update(formulaVersions)
      .set({ deactivatedAt: now })
      .where(isNull(formulaVersions.deactivatedAt))
      .run();
    return db
      .insert(formulaVersions)
      .values({ weightsJson, personaText, activatedAt: now, notes: notes ?? null })
      .returning()
      .get();
  }

  // ── EEA v1: tuning proposals ──────────────────────────────────────────────
  createTuningProposal(row: InsertTuningProposal): TuningProposal {
    return db.insert(tuningProposals).values(row).returning().get();
  }

  getPendingProposals(): TuningProposal[] {
    return db
      .select()
      .from(tuningProposals)
      .where(eq(tuningProposals.status, "pending"))
      .all();
  }

  updateProposalStatus(id: number, status: "accepted" | "rejected"): TuningProposal | undefined {
    db.update(tuningProposals)
      .set({ status, reviewedAt: new Date() })
      .where(eq(tuningProposals.id, id))
      .run();
    return db.select().from(tuningProposals).where(eq(tuningProposals.id, id)).get();
  }

  // ── EEA v1: bias reads ────────────────────────────────────────────────────
  upsertBiasRead(row: InsertBiasRead): BiasRead {
    db.delete(biasReads)
      .where(and(eq(biasReads.track, row.track), eq(biasReads.date, row.date)))
      .run();
    return db.insert(biasReads).values(row).returning().get();
  }

  getBiasRead(track: string, date: string): BiasRead | undefined {
    return db
      .select()
      .from(biasReads)
      .where(and(eq(biasReads.track, track), eq(biasReads.date, date)))
      .get();
  }

  // ── EEA v1: maiden enrichment ─────────────────────────────────────────────
  upsertMaidenEnrichment(row: InsertMaidenEnrichment): MaidenEnrichment {
    db.delete(maidenEnrichment)
      .where(
        and(
          eq(maidenEnrichment.raceId, row.raceId),
          eq(maidenEnrichment.horsePgm, row.horsePgm),
        ),
      )
      .run();
    return db.insert(maidenEnrichment).values(row).returning().get();
  }

  getMaidenEnrichment(raceId: number, horsePgm: string): MaidenEnrichment | undefined {
    return db
      .select()
      .from(maidenEnrichment)
      .where(
        and(
          eq(maidenEnrichment.raceId, raceId),
          eq(maidenEnrichment.horsePgm, horsePgm),
        ),
      )
      .get();
  }

  // ── Print view: Anthropic race summaries ──────────────────────────────────
  getRaceSummary(raceId: number): RaceSummary | undefined {
    return db.select().from(raceSummaries).where(eq(raceSummaries.raceId, raceId)).get();
  }

  upsertRaceSummary(row: InsertRaceSummary & { raceId: number }): RaceSummary {
    db.delete(raceSummaries).where(eq(raceSummaries.raceId, row.raceId)).run();
    return db.insert(raceSummaries).values(row).returning().get();
  }

  // ── Voice subsystem ─────────────────────────────────────────────────────
  createVoiceConversation(row: {
    cardId: number;
    userTranscript: string;
    jarvisResponse: string;
    appliedChanges?: string | null;
    contextSummary?: string | null;
  }): VoiceConversation {
    return db
      .insert(voiceConversations)
      .values({
        cardId: row.cardId,
        userTranscript: row.userTranscript,
        jarvisResponse: row.jarvisResponse,
        appliedChanges: row.appliedChanges ?? null,
        contextSummary: row.contextSummary ?? null,
        createdAt: new Date(),
      })
      .returning()
      .get();
  }

  getVoiceConversations(cardId: number): VoiceConversation[] {
    return db
      .select()
      .from(voiceConversations)
      .where(eq(voiceConversations.cardId, cardId))
      .orderBy(voiceConversations.id)
      .all();
  }

  getVoiceConversation(id: number): VoiceConversation | undefined {
    return db.select().from(voiceConversations).where(eq(voiceConversations.id, id)).get();
  }

  createVoiceConversationApplied(id: number, appliedChangesJson: string): void {
    db.update(voiceConversations)
      .set({ appliedChanges: appliedChangesJson })
      .where(eq(voiceConversations.id, id))
      .run();
  }

  markVoiceConversationReverted(id: number): void {
    db.update(voiceConversations).set({ reverted: true }).where(eq(voiceConversations.id, id)).run();
  }

  // Most recent conversation on this card that applied changes and isn't reverted.
  getLastAppliedVoiceConversation(cardId: number): VoiceConversation | undefined {
    return db
      .select()
      .from(voiceConversations)
      .where(and(eq(voiceConversations.cardId, cardId), eq(voiceConversations.reverted, false)))
      .orderBy(desc(voiceConversations.id))
      .all()
      .find((c) => !!c.appliedChanges && c.appliedChanges !== "[]");
  }

  // Snapshot the mutable race fields so a voice update can be reverted.
  snapshotRace(
    cardId: number,
    raceId: number,
    trigger: "initial" | "voice_update" | "manual",
    voiceConversationId?: number,
  ): PredictionHistory {
    const race = this.getRace(raceId);
    const snapshot = race
      ? JSON.stringify({
          tier: race.tier,
          winPgm: race.winPgm, winName: race.winName, winScore: race.winScore,
          placePgm: race.placePgm, placeName: race.placeName, placeScore: race.placeScore,
          showPgm: race.showPgm, showName: race.showName, showScore: race.showScore,
          fourthPgm: race.fourthPgm, fourthName: race.fourthName, fourthScore: race.fourthScore,
          read: race.read, shape: race.shape, flags: race.flags,
        })
      : "{}";
    return db
      .insert(predictionHistory)
      .values({
        cardId,
        raceId,
        snapshot,
        trigger,
        voiceConversationId: voiceConversationId ?? null,
        createdAt: new Date(),
      })
      .returning()
      .get();
  }

  getLatestSnapshot(raceId: number): PredictionHistory | undefined {
    return db
      .select()
      .from(predictionHistory)
      .where(eq(predictionHistory.raceId, raceId))
      .orderBy(desc(predictionHistory.id))
      .all()[0];
  }

  // ── Deep post-mortem (PR #25) ──────────────────────────────────────────────
  // Idempotent: delete-then-insert so re-running the analyzer for a card
  // replaces the prior report rather than stacking rows.
  upsertDeepPostmortem(cardId: number, payload: DeepPostmortem): DeepPostmortemRow {
    db.delete(deepPostmortems).where(eq(deepPostmortems.cardId, cardId)).run();
    return db
      .insert(deepPostmortems)
      .values({
        cardId,
        generatedAt: payload.generatedAt,
        payload: JSON.stringify(payload),
      })
      .returning()
      .get();
  }

  getDeepPostmortem(cardId: number): DeepPostmortem | null {
    const row = db
      .select()
      .from(deepPostmortems)
      .where(eq(deepPostmortems.cardId, cardId))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as DeepPostmortem;
    } catch {
      return null;
    }
  }
}

export const storage = new DatabaseStorage();

// Seed the v1 persona + default weights into formula_versions on first boot.
export function seedFormulaVersion(): void {
  const active = storage.getActiveFormulaVersion();
  if (active) return;
  storage.createFormulaVersion({
    weightsJson: JSON.stringify(DEFAULT_WEIGHTS),
    personaText: PERSONA_V1,
    activatedAt: new Date(),
    deactivatedAt: null,
    notes: "Persona v1 (seed)",
  });
  console.log("[seed] formula_versions seeded with persona v1 + default weights");
}

// ── Seed: Saratoga June 7 2026 card + R1 result ───────────────────────────
type SeedRace = {
  n: number;
  tier: string;
  post: string;
  conditions: string;
  shape: string;
  read: string;
  flags: string[];
  win: { pgm: string; name: string; score: number };
  place: { pgm: string; name: string; score: number };
  show: { pgm: string; name: string; score: number };
  fourth: { pgm: string; name: string; score: number };
};

const SARATOGA_RACES: SeedRace[] = [
  { n: 1, tier: "DUAL", post: "12:05 PM",
    conditions: "Alw 105k N1X · 1 1/16M Turf · RR 81",
    shape: "Two-headed class race — All of It and Tongue Twister both legitimate tops",
    read: "Tongue Twister (Class 81) joins All of It at the top — Quant-Capper missed her. Two-horse exotic.",
    flags: ["BOUNCE RISK on #4"],
    win: { pgm: "2", name: "All of It", score: 83.9 },
    place: { pgm: "10", name: "Tongue Twister", score: 81.0 },
    show: { pgm: "5", name: "Neshika", score: 77.0 },
    fourth: { pgm: "4", name: "Boomington", score: 78.5 } },
  { n: 2, tier: "RECON", post: "12:38 PM",
    conditions: "Mdn 100k · 1 1/16M Turf · RR 80",
    shape: "Maiden route — Soaring Spirit best-rounded, Pelican Pride & Amazing Gracer real threats",
    read: "Equibase reveals 3 horses within 2 class points. Small win play, broader exotics.",
    flags: ["VALUE GATE on #2"],
    win: { pgm: "7", name: "Soaring Spirit", score: 81.0 },
    place: { pgm: "8", name: "Pelican Pride", score: 80.0 },
    show: { pgm: "10", name: "Amazing Gracer", score: 79.0 },
    fourth: { pgm: "2", name: "New York Special", score: 71.0 } },
  { n: 3, tier: "SNIPER", post: "1:11 PM",
    conditions: "OptClm 125k · 7F Dirt · RR 90",
    shape: "Scottish Lassie class edge too big to fade — 4 points clear of the field",
    read: "Lassie back on top — Class 94, Highest SPD 102 dominant. Bounce flag managed via exotic structure.",
    flags: ["BOUNCE RISK noted"],
    win: { pgm: "3", name: "Scottish Lassie", score: 94.0 },
    place: { pgm: "5", name: "Filly Freedom", score: 84.0 },
    show: { pgm: "1", name: "Limes Don't Lie", score: 83.0 },
    fourth: { pgm: "2", name: "Roman Grace", score: 81.0 } },
  { n: 4, tier: "SNIPER", post: "1:46 PM",
    conditions: "Poker S. (G3) · 1M Turf · RR 107",
    shape: "Class race of the day — Zulu Kingdom and Ridari are co-class tops",
    read: "Equibase has Ridari co-top class — Quant-Capper buried him 5th. Restructure exotic 2 / 3, 10, 7.",
    flags: [],
    win: { pgm: "2", name: "Zulu Kingdom", score: 106.0 },
    place: { pgm: "3", name: "Ridari (FR)", score: 106.0 },
    show: { pgm: "10", name: "Ignite the Light", score: 99.0 },
    fourth: { pgm: "7", name: "Salamis", score: 94.0 } },
  { n: 5, tier: "PASS", post: "2:20 PM",
    conditions: "Alw 105k · 5½F Turf · RR 87 · 16 ENTRIES",
    shape: "Wide-open turf scramble — My Life Story & Punto Forty live longshots",
    read: "16-horse turf sprint. PASS win bet — cheap exotic spread only.",
    flags: ["FIELD SIZE chaos"],
    win: { pgm: "7", name: "Moonlight Drive", score: 79.0 },
    place: { pgm: "1", name: "New York Scrappy", score: 82.0 },
    show: { pgm: "16", name: "My Life Story", score: 82.0 },
    fourth: { pgm: "12", name: "Punto Forty", score: 73.0 } },
  { n: 6, tier: "EDGE", post: "2:54 PM",
    conditions: "Mdn 115k · 5½F Dirt · 2YO · RR 80",
    shape: "Cut Down the Nets has a real debut number — Class 85 dominates",
    read: "Equibase upgrades this from PASS. Debut winner #4 stands out by 9 class points.",
    flags: [],
    win: { pgm: "4", name: "Cut Down the Nets", score: 85.0 },
    place: { pgm: "8", name: "Motawaali", score: 76.0 },
    show: { pgm: "3", name: "Just a Holiday", score: 73.0 },
    fourth: { pgm: "9", name: "Booked", score: 72.0 } },
  { n: 7, tier: "EDGE", post: "3:29 PM",
    conditions: "Starter OptClm 78k · 1 1/16M Turf · RR 94",
    shape: "Vintage Vino class top — Quant-Capper had him 6th",
    read: "Major flip — Vintage Vino tops on Class 90. Live value at projected 8-1+.",
    flags: ["TRIP-AIDED on #7"],
    win: { pgm: "15", name: "Vintage Vino", score: 90.0 },
    place: { pgm: "6", name: "Bridle a Butterfly", score: 87.0 },
    show: { pgm: "3", name: "Gene and Jude", score: 86.0 },
    fourth: { pgm: "7", name: "Final Denile", score: 84.0 } },
  { n: 8, tier: "SNIPER", post: "4:04 PM",
    conditions: "Soaring Softly S. (G3) · 5½F Turf · RR 104",
    shape: "Slay the Day even more dominant in Equibase — 12+ class points clear",
    read: "Cadenza is the proper 2nd on figures, not Hen Party. Exacta 4 / 3, 1, 6.",
    flags: [],
    win: { pgm: "4", name: "Slay the Day", score: 98.0 },
    place: { pgm: "3", name: "Cadenza", score: 86.0 },
    show: { pgm: "1", name: "Hen Party", score: 81.0 },
    fourth: { pgm: "6", name: "Should've", score: 83.0 } },
  { n: 9, tier: "EDGE", post: "4:39 PM",
    conditions: "Starter OptClm 52k · 6½F Dirt · RR 94",
    shape: "Secured Landing class top — Shoot the Nickel was 4th-best, not 1st",
    read: "Top pick flips — Secured Landing's class 88 over Shoot the Nickel's 80. Olazabal live longshot.",
    flags: ["BOUNCE RISK on #1"],
    win: { pgm: "6", name: "Secured Landing", score: 88.0 },
    place: { pgm: "1", name: "Gatsby", score: 87.0 },
    show: { pgm: "11", name: "Olazabal", score: 84.0 },
    fourth: { pgm: "12", name: "Shoot the Nickel", score: 80.0 } },
  { n: 10, tier: "EDGE", post: "5:14 PM",
    conditions: "Alw 105k · 7F Dirt · RR 89",
    shape: "Toscano class top — Mo for the King is the live longshot",
    read: "Major flip from Sunday Boy. Mo for the King has field-high Highest SPD 105 — upgrade to 2nd.",
    flags: ["VALUE GATE on #1"],
    win: { pgm: "1", name: "Toscano", score: 82.0 },
    place: { pgm: "8", name: "Mo for the King", score: 82.0 },
    show: { pgm: "5", name: "Anyway", score: 77.0 },
    fourth: { pgm: "9", name: "Sunday Boy", score: 75.0 } },
  { n: 11, tier: "SNIPER", post: "5:49 PM",
    conditions: "Mdn 100k · 6½F Dirt · RR 83",
    shape: "Best maiden race on figures — Irish Goodbye Class 82 matches race par",
    read: "Aristide Maillol (Mott trainee, field-high Last Pace 89) added to exotic.",
    flags: [],
    win: { pgm: "11", name: "Irish Goodbye", score: 82.0 },
    place: { pgm: "7", name: "Aristide Maillol", score: 70.0 },
    show: { pgm: "4", name: "King Farro", score: 70.0 },
    fourth: { pgm: "5", name: "Hurricane Kaz", score: 65.0 } },
];

export function seedSaratogaCard(): void {
  const existing = storage.getCards();
  if (existing.length > 0) return;

  const raceRows: Omit<InsertRace, "cardId">[] = SARATOGA_RACES.map((r) => ({
    raceNumber: r.n,
    tier: r.tier,
    post: r.post,
    conditions: r.conditions,
    shape: r.shape,
    read: r.read,
    flags: JSON.stringify(r.flags),
    winPgm: r.win.pgm, winName: r.win.name, winScore: r.win.score,
    placePgm: r.place.pgm, placeName: r.place.name, placeScore: r.place.score,
    showPgm: r.show.pgm, showName: r.show.name, showScore: r.show.score,
    fourthPgm: r.fourth.pgm, fourthName: r.fourth.name, fourthScore: r.fourth.score,
    whyText: null,
    paceText: null,
  }));

  const card = storage.createCard(
    {
      track: "Saratoga",
      date: "2026-06-07",
      cardConviction: "HIGH",
      notes: null,
      locked: false,
    },
    raceRows,
  );

  // Seed R1 result: finish 2-1-7-5 → WIN ✅ (PLACE/SHOW/4TH ❌, ITM 2/4)
  const r1 = card.races.find((r) => r.raceNumber === 1);
  if (r1) {
    storage.logResult(r1.id, ["2", "1", "7", "5"], {
      winPayout: 7.4,
      placePayout: 3.8,
      showPayout: 2.9,
      exactaPayout: 38.5,
    });
  }

  // Seed R2 result: finish 2-11-9-10 → 4TH-slot pick #2 won outright, top-3 missed ITM, our 4th pick took it. ITM 1/4.
  const r2 = card.races.find((r) => r.raceNumber === 2);
  if (r2) {
    storage.logResult(r2.id, ["2", "11", "9", "10"], {
      winPayout: 8.86,
      placePayout: 4.74,
      showPayout: 4.20,
      exactaPayout: null,
    });
  }

  // Seed R3 result: finish 3-1-4-5 → SNIPER tier WIN ✅ + SHOW ✅, ITM 3/4. Top pick #3 Scottish Lassie won at $3.50.
  const r3 = card.races.find((r) => r.raceNumber === 3);
  if (r3) {
    storage.logResult(r3.id, ["3", "1", "4", "5"], {
      winPayout: 3.50,
      placePayout: 2.24,
      showPayout: 2.10,
      exactaPayout: null,
    });
  }

  // Ensure a settings row exists.
  storage.getSettings();
  console.log("[seed] Saratoga 2026-06-07 card seeded with 11 races + R1, R2, R3 results");
}
