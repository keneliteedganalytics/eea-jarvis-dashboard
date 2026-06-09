import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated throwaway DB before any db/service import.
const TMP_DB = path.join(os.tmpdir(), `eea-sesscache-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

// Mock the Playwright-backed acquire functions so no browser ever launches.
const acquireBrisnet = vi.fn();
const acquireEquibase = vi.fn();
vi.mock("../services/browser-session", () => ({
  acquireBrisnetSession: (...a: unknown[]) => acquireBrisnet(...a),
  acquireEquibaseSession: (...a: unknown[]) => acquireEquibase(...a),
}));

import {
  getOrAcquire,
  invalidate,
  isFresh,
  ensureSessionTable,
  SESSION_TTL_MS,
} from "../services/session-cache";
import type { BrowserSession } from "../services/browser-session";
import { sqlite } from "../db";

function session(over: Partial<BrowserSession> = {}): BrowserSession {
  return {
    cookies: [
      { name: "PHPSESSID", value: "x", domain: "d", path: "/", expires: -1, httpOnly: true, secure: true },
    ],
    userAgent: "UA",
    acquiredAt: new Date(),
    expiresAt: undefined,
    provider: "brisnet",
    ...over,
  };
}

beforeEach(() => {
  sqlite.exec("DELETE FROM provider_sessions");
  acquireBrisnet.mockReset();
  acquireEquibase.mockReset();
  process.env.BRISNET_USERNAME = "Ken6741";
  process.env.BRISNET_PASSWORD = "pw";
  process.env.EQUIBASE_USERNAME = "Ken6741";
  process.env.EQUIBASE_PASSWORD = "pw";
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("ensureSessionTable", () => {
  it("creates the provider_sessions table idempotently", () => {
    ensureSessionTable();
    ensureSessionTable(); // second call must not throw
    const cols = sqlite.prepare("PRAGMA table_info(provider_sessions)").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["acquired_at", "cookies_json", "expires_at", "provider", "user_agent"].sort(),
    );
  });
});

describe("isFresh", () => {
  it("is false once older than the TTL", () => {
    const old = session({ acquiredAt: new Date(Date.now() - SESSION_TTL_MS - 1000) });
    expect(isFresh(old)).toBe(false);
  });

  it("is false when the cookie expiry has passed", () => {
    const s = session({ acquiredAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
    expect(isFresh(s)).toBe(false);
  });

  it("is true when young and unexpired", () => {
    const s = session({ acquiredAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    expect(isFresh(s)).toBe(true);
  });
});

describe("getOrAcquire", () => {
  it("acquires on a cold cache and persists the row", async () => {
    acquireBrisnet.mockResolvedValue(session());
    const s = await getOrAcquire("brisnet");
    expect(s.provider).toBe("brisnet");
    expect(acquireBrisnet).toHaveBeenCalledTimes(1);
    const row = sqlite
      .prepare("SELECT COUNT(*) AS c FROM provider_sessions WHERE provider='brisnet'")
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("returns the cached session without re-acquiring while fresh", async () => {
    acquireBrisnet.mockResolvedValue(session());
    await getOrAcquire("brisnet");
    await getOrAcquire("brisnet");
    expect(acquireBrisnet).toHaveBeenCalledTimes(1);
  });

  it("re-acquires once the cached row is past the TTL", async () => {
    acquireBrisnet.mockResolvedValue(session());
    await getOrAcquire("brisnet");
    // Backdate the stored acquired_at beyond the TTL.
    const stale = new Date(Date.now() - SESSION_TTL_MS - 60_000).toISOString();
    sqlite
      .prepare("UPDATE provider_sessions SET acquired_at=? WHERE provider='brisnet'")
      .run(stale);
    await getOrAcquire("brisnet");
    expect(acquireBrisnet).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent cold-cache calls (one acquisition)", async () => {
    let resolve!: (s: BrowserSession) => void;
    acquireBrisnet.mockImplementation(
      () => new Promise<BrowserSession>((r) => (resolve = r)),
    );
    const p1 = getOrAcquire("brisnet");
    const p2 = getOrAcquire("brisnet");
    resolve(session());
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(acquireBrisnet).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
  });

  it("force bypasses a fresh cache", async () => {
    acquireBrisnet.mockResolvedValue(session());
    await getOrAcquire("brisnet");
    await getOrAcquire("brisnet", { force: true });
    expect(acquireBrisnet).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error when credentials are missing", async () => {
    delete process.env.BRISNET_USERNAME;
    delete process.env.BRISNET_PASSWORD;
    delete process.env.BRISNET_USER;
    delete process.env.BRISNET_PASS;
    await expect(getOrAcquire("brisnet")).rejects.toThrow(/not set/);
    expect(acquireBrisnet).not.toHaveBeenCalled();
  });

  it("routes equibase to its own acquire fn", async () => {
    acquireEquibase.mockResolvedValue(session({ provider: "equibase" }));
    const s = await getOrAcquire("equibase");
    expect(s.provider).toBe("equibase");
    expect(acquireEquibase).toHaveBeenCalledTimes(1);
    expect(acquireBrisnet).not.toHaveBeenCalled();
  });
});

describe("invalidate", () => {
  it("drops the cached row so the next call re-acquires", async () => {
    acquireBrisnet.mockResolvedValue(session());
    await getOrAcquire("brisnet");
    invalidate("brisnet");
    await getOrAcquire("brisnet");
    expect(acquireBrisnet).toHaveBeenCalledTimes(2);
  });
});
