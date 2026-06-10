import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file — set before importing db/storage so the
// runtime CREATE TABLE bootstrap runs against this file.
const TMP_DB = path.join(os.tmpdir(), `eea-swap-picks-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

const PIN = "5811"; // admin-pin.ts default when ADMIN_PIN is unset

// Mirror the real wiring: PIN gate on /api before the mutating route, then mount
// exactly the swap-picks endpoint as defined in server/routes.ts.
async function startServer(): Promise<{ base: string; server: Server }> {
  const { adminPinGate } = await import("../middleware/admin-pin");
  const { storage } = await import("../storage");

  const app = express();
  app.use(express.json());
  app.use("/api", adminPinGate);

  app.post("/api/races/:id/swap-picks", (req, res) => {
    const raceId = Number(req.params.id);
    const newWinPgm = typeof req.body?.newWinPgm === "string" ? req.body.newWinPgm.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    if (!newWinPgm) return res.status(400).json({ error: "newWinPgm is required" });
    const race = storage.getRace(raceId);
    if (!race) return res.status(404).json({ error: "Race not found" });
    try {
      storage.swapWinPick(raceId, newWinPgm, reason);
      res.json(storage.getCardWithRaces(race.cardId));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
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

// Seed a card with one race carrying four populated picks (win=3,place=5,show=7,fourth=9).
async function seedRace() {
  const { storage } = await import("../storage");
  const card = storage.createCard({ track: "Finger Lakes", date: "2026-06-10" }, [
    { raceNumber: 6, tier: "EDGE", flags: "[]" },
  ]);
  const race = storage.getRacesByCard(card.id)[0];
  storage.updateRaceFusion(race.id, {
    winPgm: "3", winName: "Win Horse", winScore: 88,
    placePgm: "5", placeName: "Place Horse", placeScore: 80,
    showPgm: "7", showName: "Show Horse", showScore: 72,
    fourthPgm: "9", fourthName: "Fourth Horse", fourthScore: 65,
  });
  return { cardId: card.id, raceId: race.id };
}

describe("POST /api/races/:id/swap-picks", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const started = await startServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => server?.close());

  it("rejects the swap without the admin PIN (401)", async () => {
    const { raceId } = await seedRace();
    const res = await fetch(`${base}/api/races/${raceId}/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newWinPgm: "7" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s when newWinPgm is missing", async () => {
    const { raceId } = await seedRace();
    const res = await fetch(`${base}/api/races/${raceId}/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ reason: "no pgm" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s a non-existent race", async () => {
    const res = await fetch(`${base}/api/races/999999/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ newWinPgm: "7" }),
    });
    expect(res.status).toBe(404);
  });

  it("promotes an on-board horse to win and cascades the rest down", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    const res = await fetch(`${base}/api/races/${raceId}/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ newWinPgm: "7", reason: "Wet-track override" }),
    });
    expect(res.status).toBe(200);

    // Promoted #7 → win; old win #3 demotes to place; #5 → show; #9 → fourth.
    const race = storage.getRace(raceId)!;
    expect(race.winPgm).toBe("7");
    expect(race.winName).toBe("Show Horse");
    expect(race.placePgm).toBe("3");
    expect(race.showPgm).toBe("5");
    expect(race.fourthPgm).toBe("9");
  });

  it("records a MANUAL_OVERRIDE race_event with the reason and old/new picks", async () => {
    const { raceId } = await seedRace();
    const { storage } = await import("../storage");
    await fetch(`${base}/api/races/${raceId}/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ newWinPgm: "5", reason: "Mattice pace pick" }),
    });
    const events = storage.getRaceEvents(raceId).filter((e) => e.type === "MANUAL_OVERRIDE");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].payloadJson || "{}");
    expect(payload.newWinPgm).toBe("5");
    expect(payload.reason).toBe("Mattice pace pick");
    expect(payload.oldPicks.win).toBe("3");
    expect(payload.newPicks.win).toBe("5");
  });

  it("400s when the requested horse is already the win pick", async () => {
    const { raceId } = await seedRace();
    const res = await fetch(`${base}/api/races/${raceId}/swap-picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": PIN },
      body: JSON.stringify({ newWinPgm: "3" }),
    });
    expect(res.status).toBe(400);
  });
});
