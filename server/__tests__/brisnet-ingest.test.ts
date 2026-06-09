import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { sqlite } from "../db";

// Isolated throwaway SQLite file + DRM dir — set before importing db/services.
const TMP_DB = path.join(os.tmpdir(), `eea-brisnet-${Date.now()}.db`);
const TMP_DRM = path.join(os.tmpdir(), `eea-brisnet-drm-${Date.now()}`);
process.env.DATABASE_FILE = TMP_DB;
process.env.BRISNET_DRM_DIR = TMP_DRM;

import {
  parseCsvLine,
  drDateToIso,
  parseDr2,
  extractDrmZip,
  parseDrmZip,
} from "../services/parsers/brisnet-drm";
import {
  buildDownloadUrl,
  formatRaceDateParam,
  ymd,
  parseSetCookies,
  hasSessionCookie,
  loginBrisnet,
  downloadDrmZip,
  persistCard,
  type CookieJar,
} from "../services/brisnet-ingest";

const FIXTURE = path.join(
  __dirname,
  "..",
  "services",
  "__fixtures__",
  "brisnet",
  "flx0608n.zip",
);
const FIXTURE_BUF = readFileSync(FIXTURE);
const JUN8 = new Date(2026, 5, 8);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(TMP_DRM, { recursive: true, force: true });
});

describe("CSV + date helpers", () => {
  it("splits quoted comma-delimited fields and trims quotes", () => {
    expect(parseCsvLine('"FL ","20260608", 1, 1,,,"BREED RONALD JR"')).toEqual([
      "FL ",
      "20260608",
      " 1",
      " 1",
      "",
      "",
      "BREED RONALD JR",
    ]);
  });

  it("keeps commas that are inside quoted fields", () => {
    expect(parseCsvLine('"a,b","c"')).toEqual(["a,b", "c"]);
  });

  it("converts BRIS YYYYMMDD to ISO", () => {
    expect(drDateToIso("20260608")).toBe("2026-06-08");
    expect(drDateToIso("bad")).toBe("");
  });
});

describe("buildDownloadUrl", () => {
  // PR #30: confirmed from live recon — lowercase `drm` segment (PR #29 guessed
  // uppercase DRM and 404'd).
  it("matches the recon-confirmed DRM download pattern exactly", () => {
    expect(buildDownloadUrl("FL", JUN8)).toBe(
      "https://www.brisnet.com/product/download/2026-06-08/drm/USA/TB/FL/D/0/",
    );
  });

  it("returns the exact URL for FL on 2026-06-09 (spec acceptance string)", () => {
    expect(buildDownloadUrl("FL", new Date(2026, 5, 9))).toBe(
      "https://www.brisnet.com/product/download/2026-06-09/drm/USA/TB/FL/D/0/",
    );
  });

  it("uppercases the track code", () => {
    expect(buildDownloadUrl("alb", JUN8)).toBe(
      "https://www.brisnet.com/product/download/2026-06-08/drm/USA/TB/ALB/D/0/",
    );
  });

  it("formats race date and folder name", () => {
    expect(formatRaceDateParam(JUN8)).toBe("2026-06-08");
    expect(ymd(JUN8)).toBe("20260608");
  });
});

describe("extractDrmZip", () => {
  it("pulls all four DR* members out of the real fixture", () => {
    const files = extractDrmZip(FIXTURE_BUF);
    expect(Object.keys(files).sort()).toEqual(["dr2", "dr3", "dr4", "drf"]);
    expect(files.dr2!.length).toBeGreaterThan(1000);
  });
});

describe("parseDr2 / parseDrmZip (real Finger Lakes 2026-06-08 fixture)", () => {
  const card = parseDrmZip(FIXTURE_BUF, "FL");

  it("identifies the card track and date", () => {
    expect(card.trackCode).toBe("FL");
    expect(card.raceDate).toBe("2026-06-08");
  });

  it("groups every race on the card", () => {
    expect(card.races.length).toBe(8);
    expect(card.races.map((r) => r.raceNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reads race-level BRIS pars off race 1", () => {
    const r1 = card.races[0];
    expect(r1.speedParEarly).toBe(92);
    expect(r1.speedParLate).toBe(93);
    expect(r1.paceParE1).toBe(81);
    expect(r1.paceParE2).toBe(82);
  });

  it("parses a sample horse's high-value fields (R1 pgm 5)", () => {
    const r1 = card.races[0];
    const h5 = r1.horses.find((h) => h.programNumber === "5")!;
    expect(h5.runStyle).toBe("P");
    expect(h5.primePower).toBe(81);
    expect(h5.bestSpeed).toBe(81);
    expect(h5.mlOdds).toBe(3.5);
    // Raw row is preserved for later re-parse.
    expect(Array.isArray(h5.rawRow)).toBe(true);
    expect(h5.rawRow.length).toBeGreaterThan(200);
  });

  it("orders horses by post position", () => {
    const pgms = card.races[0].horses.map((h) => h.programNumber);
    expect(pgms).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("falls back to the supplied track when the row track is blank", () => {
    const c = parseDr2('"","20260608", 2, 3,,,"x"', "ALB");
    expect(c.trackCode).toBe("ALB");
    expect(c.races[0].raceNumber).toBe(2);
  });
});

describe("persistCard -> brisnet_horse_data", () => {
  it("writes one row per horse keyed by (date,track,race,pgm) and upserts", () => {
    const card = parseDrmZip(FIXTURE_BUF, "FL");
    const total = card.races.reduce((n, r) => n + r.horses.length, 0);

    const written = persistCard(card, JUN8);
    expect(written).toBe(total);

    const rows = sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM brisnet_horse_data WHERE race_date=? AND track_code=?",
      )
      .get("2026-06-08", "FL") as { c: number };
    expect(rows.c).toBe(total);

    const h5 = sqlite
      .prepare(
        "SELECT prime_power AS pp, run_style AS rs FROM brisnet_horse_data WHERE race_date=? AND track_code=? AND race_number=1 AND program_number='5'",
      )
      .get("2026-06-08", "FL") as { pp: number; rs: string };
    expect(h5.pp).toBe(81);
    expect(h5.rs).toBe("P");

    // Re-running must not duplicate (ON CONFLICT upsert on the unique key).
    persistCard(card, JUN8);
    const after = sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM brisnet_horse_data WHERE race_date=? AND track_code=?",
      )
      .get("2026-06-08", "FL") as { c: number };
    expect(after.c).toBe(total);
  });
});

describe("parseSetCookies / session detection", () => {
  it("captures name=value pairs and drops attributes", () => {
    const jar = parseSetCookies([
      "PHPSESSID=abc123; path=/; HttpOnly",
      "csrf=zzz; Secure",
    ]);
    expect(jar.get("PHPSESSID")).toBe("abc123");
    expect(jar.get("csrf")).toBe("zzz");
  });

  it("recognizes any *SESS* cookie as a session", () => {
    expect(hasSessionCookie(new Map([["PHPSESSID", "x"]]))).toBe(true);
    expect(hasSessionCookie(new Map([["SYMFONY_SESSION", "x"]]))).toBe(true);
    expect(hasSessionCookie(new Map([["csrf", "x"]]))).toBe(false);
  });
});

describe("loginBrisnet redirect-chain cookie capture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeHeaders(setCookies: string[], location?: string): Headers {
    const h = new Headers();
    for (const c of setCookies) h.append("set-cookie", c);
    if (location) h.set("location", location);
    return h;
  }
  function makeResponse(
    status: number,
    setCookies: string[],
    location?: string,
    body = "",
    contentType?: string,
  ): Response {
    const headers = makeHeaders(setCookies, location);
    if (contentType) headers.set("content-type", contentType);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      clone: () => makeResponse(status, setCookies, location, body, contentType),
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }

  it("captures PHPSESSID set on the 302 hop and reuses it on the follow-up", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeResponse(
          302,
          ["PHPSESSID=sess123; path=/; HttpOnly"],
          "https://www.brisnet.com/product/account",
        ),
      )
      .mockResolvedValueOnce(makeResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);

    const jar = await loginBrisnet("Ken6741", "pw!");
    expect(jar.get("PHPSESSID")).toBe("sess123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect((second.headers as Record<string, string>).Cookie).toContain(
      "PHPSESSID=sess123",
    );
  });

  it("sends a browser User-Agent on the login POST", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(200, ["PHPSESSID=x; path=/"]));
    vi.stubGlobal("fetch", fetchMock);
    await loginBrisnet("u", "p");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain(
      "Chrome/",
    );
  });

  it("throws when no session cookie is set", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(200, ["foo=bar; path=/"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loginBrisnet("u", "p")).rejects.toThrow(
      /did not set a session cookie/,
    );
  });
});

describe("downloadDrmZip content-type guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const jar: CookieJar = new Map([["PHPSESSID", "x"]]);

  function res(
    status: number,
    body: ArrayBuffer | string,
    contentType: string,
    location?: string,
  ): Response {
    const headers = new Headers();
    headers.set("content-type", contentType);
    if (location) headers.set("location", location);
    const ab =
      typeof body === "string"
        ? (new TextEncoder().encode(body).buffer as ArrayBuffer)
        : body;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      arrayBuffer: async () => ab,
    } as unknown as Response;
  }

  it("returns the zip bytes on a real zip response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          res(200, FIXTURE_BUF.buffer.slice(
            FIXTURE_BUF.byteOffset,
            FIXTURE_BUF.byteOffset + FIXTURE_BUF.byteLength,
          ) as ArrayBuffer, "application/zip"),
        ),
    );
    const { buf } = await downloadDrmZip(jar, "FL", JUN8);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
  });

  it("rejects an HTML (expired-session) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(res(200, "<html>login</html>", "text/html")),
    );
    await expect(downloadDrmZip(jar, "FL", JUN8)).rejects.toThrow(/HTML/);
  });

  it("rejects a redirect to the login page", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          res(302, "", "text/html", "https://www.brisnet.com/product/login"),
        ),
    );
    await expect(downloadDrmZip(jar, "FL", JUN8)).rejects.toThrow(/session/);
  });

  it("rejects a non-zip binary served with a non-html type", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(res(200, "not a zip", "application/octet-stream")),
    );
    await expect(downloadDrmZip(jar, "FL", JUN8)).rejects.toThrow(/not a zip/);
  });
});

describe("cron chaining", () => {
  it("exposes runBrisnetIngestNow and never throws when creds are absent", async () => {
    const { runBrisnetIngestNow } = await import("../services/brisnet-cron");
    const prevU = process.env.BRISNET_USERNAME;
    const prevP = process.env.BRISNET_PASSWORD;
    delete process.env.BRISNET_USERNAME;
    delete process.env.BRISNET_PASSWORD;
    try {
      await expect(runBrisnetIngestNow()).resolves.toBeUndefined();
    } finally {
      if (prevU !== undefined) process.env.BRISNET_USERNAME = prevU;
      if (prevP !== undefined) process.env.BRISNET_PASSWORD = prevP;
    }
  });

  it("the Equibase cron module invokes the Brisnet ingest (sequential chain)", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "services", "equibase-cron.ts"),
      "utf8",
    );
    expect(src).toContain("runBrisnetIngestNow");
  });
});

describe("brisnet admin router", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { brisnetAdminRouter } = await import("../routes/brisnet");
    const app = express();
    app.use(express.json());
    app.use("/api/admin/brisnet", brisnetAdminRouter());
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
  });

  it("400s on a missing raceDate", async () => {
    const r = await fetch(`${base}/api/admin/brisnet/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackCodes: ["FL"] }),
    });
    expect(r.status).toBe(400);
  });

  it("400s on a malformed raceDate", async () => {
    const r = await fetch(`${base}/api/admin/brisnet/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raceDate: "06/08/2026" }),
    });
    expect(r.status).toBe(400);
  });

  it("status returns the enabled tracks", async () => {
    const r = await fetch(`${base}/api/admin/brisnet/status`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { enabledTrackCodes: string[] };
    expect(Array.isArray(body.enabledTrackCodes)).toBe(true);
  });
});
