import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Isolated throwaway SQLite file — must be set before importing the db/storage.
const TMP_DB = path.join(os.tmpdir(), `eea-admin-pin-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

const PIN = "5811"; // default in admin-pin.ts when ADMIN_PIN is unset

// Mirrors the real wiring from server/routes.ts: the PIN gate is registered on
// /api before the mutating unlock route, so the route inherits the gate.
async function startServer(): Promise<{ base: string; server: Server }> {
  const { adminPinGate } = await import("../middleware/admin-pin");
  const { storage } = await import("../storage");
  const app = express();
  app.use(express.json());
  app.use("/api", adminPinGate);

  app.post("/api/cards/:id/unlock", (req, res) => {
    const id = Number(req.params.id);
    if (!storage.getCard(id)) return res.status(404).json({ error: "Card not found" });
    try {
      const card = storage.unlockCard(id);
      res.json(card);
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

describe("POST /api/cards/:id/unlock behind the admin PIN", () => {
  let base: string;
  let server: Server;
  let cardId: number;

  beforeAll(async () => {
    const { storage } = await import("../storage");
    const card = storage.createCard({ track: "Saratoga", date: "2025-08-20" }, [
      { raceNumber: 1, tier: "SNIPER", flags: "[]" },
    ]);
    cardId = card.id;
    // Put the card into the locked/completed state an auto-lock would produce.
    storage.updateCard(cardId, { status: "completed", locked: true });
    const started = await startServer();
    base = started.base;
    server = started.server;
  });

  afterAll(() => {
    server?.close();
  });

  it("rejects the unlock without the PIN header (401 + code)", async () => {
    const res = await fetch(`${base}/api/cards/${cardId}/unlock`, { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("ADMIN_PIN_REQUIRED");
  });

  it("unlocks with the correct PIN and clears both status and locked", async () => {
    const res = await fetch(`${base}/api/cards/${cardId}/unlock`, {
      method: "POST",
      headers: { "x-admin-pin": PIN },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    // Regression: unlock used to leave `locked` true, so an auto-locked active
    // card stayed read-only. It must now be false.
    expect(body.locked).toBe(false);

    const { storage } = await import("../storage");
    const persisted = storage.getCard(cardId);
    expect(persisted?.locked).toBe(false);
    expect(persisted?.status).toBe("active");
  });
});
