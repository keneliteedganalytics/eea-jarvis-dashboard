import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TMP_DB = path.join(os.tmpdir(), `eea-analytics-scope-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

async function startScopedServer(): Promise<{ base: string; server: Server }> {
  const { buildAnalyticsSummary, buildAnalyticsTracks } = await import("../analytics");
  const app = express();
  app.get("/api/analytics/summary", (req, res) => {
    const rawScope = String(req.query.scope || "lifetime").toLowerCase();
    const scope: "today" | "track" | "lifetime" =
      rawScope === "today" || rawScope === "track" ? (rawScope as "today" | "track") : "lifetime";
    const track = typeof req.query.track === "string" ? req.query.track : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    res.json(buildAnalyticsSummary({ scope, track, date }));
  });
  app.get("/api/analytics/tracks", (_req, res) => res.json(buildAnalyticsTracks()));
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

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

describe("Analytics scope endpoint", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const started = await startScopedServer();
    base = started.base;
    server = started.server;

    // Seed: today's Finger Lakes card (8 races), yesterday's Saratoga card (11 races).
    const { storage } = await import("../storage");
    const today = todayUtc();
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

    storage.createCard(
      { track: "Finger Lakes", date: today },
      Array.from({ length: 8 }, (_, i) => ({ raceNumber: i + 1, tier: "EDGE", flags: "[]" })),
    );
    const sar = storage.createCard(
      { track: "Saratoga", date: yesterday },
      Array.from({ length: 11 }, (_, i) => ({ raceNumber: i + 1, tier: "SNIPER", flags: "[]" })),
    );

    // Grade 1 race on Saratoga so lifetime/track has signal but today doesn't.
    const sarFull = storage.getCardWithRaces(sar.id)!;
    storage.logResult(sarFull.races[0].id, ["1", "2", "3", "4"]);
  });

  afterAll(() => {
    server?.close();
  });

  it("scope=lifetime aggregates across all cards", async () => {
    const res = await fetch(`${base}/api/analytics/summary?scope=lifetime`);
    const body = await res.json();
    expect(body.scope).toBe("lifetime");
    expect(body.totalCards).toBe(2);
    expect(body.totalRaces).toBe(19);
    expect(body.gradedRaces).toBe(1);
  });

  it("scope=today filters to today's cards only", async () => {
    const res = await fetch(`${base}/api/analytics/summary?scope=today`);
    const body = await res.json();
    expect(body.scope).toBe("today");
    expect(body.date).toBe(todayUtc());
    expect(body.totalCards).toBe(1);
    expect(body.totalRaces).toBe(8);
    // Today's only race-pool isn't graded yet, so gradedRaces should be 0.
    expect(body.gradedRaces).toBe(0);
  });

  it("scope=track filters to a single track", async () => {
    const res = await fetch(`${base}/api/analytics/summary?scope=track&track=Saratoga`);
    const body = await res.json();
    expect(body.scope).toBe("track");
    expect(body.track).toBe("Saratoga");
    expect(body.totalCards).toBe(1);
    expect(body.totalRaces).toBe(11);
    expect(body.gradedRaces).toBe(1);
  });

  it("scope=track with date narrows to that day", async () => {
    const today = todayUtc();
    const res = await fetch(
      `${base}/api/analytics/summary?scope=track&track=${encodeURIComponent("Finger Lakes")}&date=${today}`,
    );
    const body = await res.json();
    expect(body.totalCards).toBe(1);
    expect(body.totalRaces).toBe(8);
    expect(body.track).toBe("Finger Lakes");
    expect(body.date).toBe(today);
  });

  it("scope=track without a track name returns nothing (empty bucket)", async () => {
    const res = await fetch(`${base}/api/analytics/summary?scope=track`);
    const body = await res.json();
    expect(body.totalCards).toBe(0);
    expect(body.totalRaces).toBe(0);
  });

  it("invalid scope falls back to lifetime", async () => {
    const res = await fetch(`${base}/api/analytics/summary?scope=bogus`);
    const body = await res.json();
    expect(body.scope).toBe("lifetime");
    expect(body.totalCards).toBe(2);
  });

  it("/api/analytics/tracks lists distinct tracks ordered by lastDate desc", async () => {
    const res = await fetch(`${base}/api/analytics/tracks`);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    const names = body.map((r: { track: string }) => r.track);
    expect(new Set(names)).toEqual(new Set(["Finger Lakes", "Saratoga"]));
    // Finger Lakes was created with today's date, Saratoga with yesterday's,
    // so Finger Lakes should come first.
    expect(body[0].track).toBe("Finger Lakes");
  });
});

describe("get_analytics_summary voice tool", () => {
  it("forwards scope and track to buildAnalyticsSummary", async () => {
    const { getAnalyticsSummary } = await import("../services/voice-tools");
    // We don't need a fresh DB — reuse seed from above suite (it persists for the file).
    const lifetime = getAnalyticsSummary({ scope: "lifetime" }, {} as never) as {
      scope: string;
      totalCards: number;
    };
    expect(lifetime.scope).toBe("lifetime");
    expect(lifetime.totalCards).toBe(2);

    const track = getAnalyticsSummary({ scope: "track", track: "Saratoga" }, {} as never) as {
      scope: string;
      track: string;
      totalRaces: number;
    };
    expect(track.scope).toBe("track");
    expect(track.track).toBe("Saratoga");
    expect(track.totalRaces).toBe(11);
  });

  it("returns an error when scope=track but no track name given", async () => {
    const { getAnalyticsSummary } = await import("../services/voice-tools");
    const result = getAnalyticsSummary({ scope: "track" }, {} as never) as { error?: string };
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/track/i);
  });

  it("defaults to today scope when none given", async () => {
    const { getAnalyticsSummary } = await import("../services/voice-tools");
    const result = getAnalyticsSummary({}, {} as never) as { scope: string };
    expect(result.scope).toBe("today");
  });
});
