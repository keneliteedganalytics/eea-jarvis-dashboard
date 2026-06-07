import {
  cards,
  races,
  results,
  settings,
  audioCache,
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
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";
import { gradeRace, gradeFlags } from "./grading";

export interface IStorage {
  // Cards
  getCards(): Card[];
  getCard(id: number): Card | undefined;
  getLatestCard(): CardWithRaces | undefined;
  getCardWithRaces(id: number): CardWithRaces | undefined;
  createCard(card: InsertCard, raceRows: Omit<InsertRace, "cardId">[]): CardWithRaces;
  updateCard(id: number, patch: Partial<Card>): Card | undefined;
  getLockedCards(): Card[];

  // Races
  getRace(id: number): Race | undefined;
  getRacesByCard(cardId: number): Race[];
  updateRaceText(id: number, whyText?: string, paceText?: string): Race | undefined;

  // Results
  getResultByRace(raceId: number): Result | undefined;
  logResult(raceId: number, finishOrder: string[], opts?: Partial<Result>): Result;

  // Settings
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;

  // Audio cache
  getAudio(scriptHash: string): AudioCache | undefined;
  insertAudio(row: Omit<AudioCache, "id" | "createdAt">): AudioCache;
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
    const withResults: RaceWithResult[] = raceRows.map((r) => ({
      ...r,
      result: this.getResultByRace(r.id) ?? null,
    }));
    return { ...card, races: withResults };
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

  getLockedCards(): Card[] {
    return db.select().from(cards).where(eq(cards.locked, true)).all();
  }

  // ── Races ───────────────────────────────────────────────────────────────
  getRace(id: number): Race | undefined {
    return db.select().from(races).where(eq(races.id, id)).get();
  }

  getRacesByCard(cardId: number): Race[] {
    return db.select().from(races).where(eq(races.cardId, cardId)).all();
  }

  updateRaceText(id: number, whyText?: string, paceText?: string): Race | undefined {
    const patch: Partial<Race> = {};
    if (whyText !== undefined) patch.whyText = whyText;
    if (paceText !== undefined) patch.paceText = paceText;
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
    return row;
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
}

export const storage = new DatabaseStorage();

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

  // Seed R1 result: finish 2-1-7-5 → WIN ✅
  const r1 = card.races.find((r) => r.raceNumber === 1);
  if (r1) {
    storage.logResult(r1.id, ["2", "1", "7", "5"], {
      winPayout: 7.4,
      placePayout: 3.8,
      showPayout: 2.9,
      exactaPayout: 38.5,
    });
  }

  // Ensure a settings row exists.
  storage.getSettings();
  console.log("[seed] Saratoga 2026-06-07 card seeded with 11 races + R1 result");
}
