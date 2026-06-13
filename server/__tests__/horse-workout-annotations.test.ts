import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  sanitizeHorseAnnotations,
  sanitizeHorseWorkoutText,
  filterWorkoutFlags,
} from "@shared/schema";

// Isolated throwaway SQLite file — set before importing db/storage so the
// runtime CREATE TABLE bootstrap runs against this file.
const TMP_DB = path.join(os.tmpdir(), `eea-workout-annotations-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

const PIN = "5811"; // admin-pin.ts default when ADMIN_PIN is unset

// ── Pure sanitizers ────────────────────────────────────────────────────────
describe("sanitizeHorseAnnotations", () => {
  it("keeps only the four known tags and drops unknown ones (no throw)", () => {
    expect(sanitizeHorseAnnotations({ "3": ["BULLET", "BAD", "SHARP"] })).toEqual({
      "3": ["BULLET", "SHARP"],
    });
  });

  it("filters a fully-unknown tag list down to an empty array", () => {
    expect(sanitizeHorseAnnotations({ "3": ["BAD", "NOPE"] })).toEqual({ "3": [] });
  });

  it("returns null for null / non-object input", () => {
    expect(sanitizeHorseAnnotations(null)).toBeNull();
    expect(sanitizeHorseAnnotations("nope")).toBeNull();
    expect(sanitizeHorseAnnotations(["BULLET"])).toBeNull();
  });

  it("drops non-array values for a pgm", () => {
    expect(sanitizeHorseAnnotations({ "3": "BULLET", "4": ["GATE"] })).toEqual({
      "4": ["GATE"],
    });
  });
});

describe("sanitizeHorseWorkoutText", () => {
  it("keeps string values, drops non-strings", () => {
    expect(sanitizeHorseWorkoutText({ "3": "4f 47.2 H", "4": 5 })).toEqual({
      "3": "4f 47.2 H",
    });
  });
  it("returns null for non-object input", () => {
    expect(sanitizeHorseWorkoutText(null)).toBeNull();
    expect(sanitizeHorseWorkoutText(42)).toBeNull();
  });
});

describe("filterWorkoutFlags", () => {
  it("keeps base-allowlisted flags and workout-prefixed flags, drops the rest", () => {
    const flags = ["BOUNCE RISK", "BULLET_HORSES:3,6", "RANDOM", "GATE_HORSES:5"];
    const allowed = new Set(["BOUNCE RISK"]);
    expect(filterWorkoutFlags(flags, allowed)).toEqual([
      "BOUNCE RISK",
      "BULLET_HORSES:3,6",
      "GATE_HORSES:5",
    ]);
  });
});

// ── Route integration: PATCH /api/races/:id ─────────────────────────────────
// Mirror the real wiring: PIN gate on /api, then mount the annotation-patch
// branch of PATCH /api/races/:id exactly as server/routes.ts defines it.
async function startServer(): Promise<{ base: string; server: Server }> {
  const { adminPinGate } = await import("../middleware/admin-pin");
  const { storage } = await import("../storage");
  const { updateRaceTextSchema } = await import("@shared/schema");

  const app = express();
  app.use(express.json());
  app.use("/api", adminPinGate);

  app.patch("/api/races/:id", (req, res) => {
    const raceId = Number(req.params.id);
    const parsed = updateRaceTextSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    storage.updateRaceText(raceId, parsed.data.whyText, parsed.data.paceText);
    const body = (req.body ?? {}) as Record<string, unknown>;
    let annotations: string | null | undefined;
    let workoutText: string | null | undefined;
    if ("horseAnnotations" in body) {
      const clean = sanitizeHorseAnnotations(body.horseAnnotations);
      annotations = clean ? JSON.stringify(clean) : null;
    }
    if ("horseWorkoutText" in body) {
      const clean = sanitizeHorseWorkoutText(body.horseWorkoutText);
      workoutText = clean ? JSON.stringify(clean) : null;
    }
    const updated = storage.updateRaceAnnotations(raceId, annotations, workoutText);
    res.json(updated);
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

async function seedRace() {
  const { storage } = await import("../storage");
  const card = storage.createCard({ track: "Belmont", date: "2026-06-13" }, [
    { raceNumber: 1, tier: "EDGE", flags: "[]" },
  ]);
  const race = storage.getRacesByCard(card.id)[0];
  return { cardId: card.id, raceId: race.id };
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("PATCH /api/races/:id horse annotations", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const started = await startServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => server?.close());

  it("requires the admin PIN (401)", async () => {
    const { raceId } = await seedRace();
    const res = await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ horseAnnotations: { "3": ["BULLET"] } }),
    });
    expect(res.status).toBe(401);
  });

  it("404s a non-existent race", async () => {
    const res = await fetch(`${base}/api/races/999999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ horseAnnotations: { "3": ["BULLET"] } }),
    });
    expect(res.status).toBe(404);
  });

  it("persists valid annotations and filters unknown tags (no 400)", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    const res = await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({
        horseAnnotations: { "3": ["BULLET", "BAD"], "6": ["GATE", "SHARP"] },
        horseWorkoutText: { "3": "4f 47.2 H (bullet)" },
      }),
    });
    expect(res.status).toBe(200);
    const race = storage.getRace(raceId)!;
    expect(JSON.parse(race.horseAnnotations!)).toEqual({
      "3": ["BULLET"],
      "6": ["GATE", "SHARP"],
    });
    expect(JSON.parse(race.horseWorkoutText!)).toEqual({ "3": "4f 47.2 H (bullet)" });
  });

  it("stores a pgm whose tags were all unknown as an empty array (still 200)", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    const res = await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ horseAnnotations: { "3": ["BAD"] } }),
    });
    expect(res.status).toBe(200);
    const race = storage.getRace(raceId)!;
    expect(JSON.parse(race.horseAnnotations!)).toEqual({ "3": [] });
  });

  it("clears annotations when passed null", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ horseAnnotations: { "3": ["BULLET"] } }),
    });
    const res = await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ horseAnnotations: null }),
    });
    expect(res.status).toBe(200);
    const race = storage.getRace(raceId)!;
    expect(race.horseAnnotations).toBeNull();
  });

  it("leaves annotations untouched when the field is omitted", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ horseAnnotations: { "5": ["SHARP"] } }),
    });
    // A whyText-only PATCH must not wipe the previously-saved annotations.
    await fetch(`${base}/api/races/${raceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ whyText: "note only" }),
    });
    const race = storage.getRace(raceId)!;
    expect(JSON.parse(race.horseAnnotations!)).toEqual({ "5": ["SHARP"] });
  });
});
