import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";

const TMP_DB = path.join(os.tmpdir(), `eea-bris-pw-${Date.now()}.db`);
const TMP_DRM = path.join(os.tmpdir(), `eea-bris-pw-drm-${Date.now()}`);
process.env.DATABASE_FILE = TMP_DB;
process.env.BRISNET_DRM_DIR = TMP_DRM;

// Hoisted session-cache mock so brisnet-ingest's orchestration never launches a
// real browser. The direct downloadDrmZipWithSession tests don't touch it.
const getOrAcquireMock = vi.fn();
const invalidateMock = vi.fn();
vi.mock("../services/session-cache", () => ({
  getOrAcquire: (...a: unknown[]) => getOrAcquireMock(...a),
  invalidate: (...a: unknown[]) => invalidateMock(...a),
}));

import {
  downloadDrmZipWithSession,
  buildDownloadUrl,
  ingestForDate,
} from "../services/brisnet-ingest";
import type { BrowserSession } from "../services/browser-session";

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

const SESSION: BrowserSession = {
  cookies: [
    { name: "PHPSESSID", value: "sess123", domain: ".brisnet.com", path: "/", expires: -1, httpOnly: true, secure: true },
    { name: "ak_bmsc", value: "ak999", domain: ".brisnet.com", path: "/", expires: -1, httpOnly: true, secure: true },
  ],
  userAgent: "Mozilla/5.0 TestUA Chrome/120",
  acquiredAt: new Date(),
  provider: "brisnet",
};

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

function fixtureAb(): ArrayBuffer {
  return FIXTURE_BUF.buffer.slice(
    FIXTURE_BUF.byteOffset,
    FIXTURE_BUF.byteOffset + FIXTURE_BUF.byteLength,
  ) as ArrayBuffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadDrmZipWithSession", () => {
  it("sends the harvested cookies + session UA to the download URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(200, fixtureAb(), "application/zip"));
    vi.stubGlobal("fetch", fetchMock);

    const { buf } = await downloadDrmZipWithSession(SESSION, "FL", JUN8);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(buildDownloadUrl("FL", JUN8));
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Cookie).toContain("PHPSESSID=sess123");
    expect(headers.Cookie).toContain("ak_bmsc=ak999");
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 TestUA Chrome/120");
  });

  it("rejects an HTML body (expired session)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(res(200, "<html>login</html>", "text/html")),
    );
    await expect(downloadDrmZipWithSession(SESSION, "FL", JUN8)).rejects.toThrow(/HTML/);
  });

  it("rejects a redirect to the login page as an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(res(302, "", "text/html", "https://www.brisnet.com/product/login")),
    );
    await expect(downloadDrmZipWithSession(SESSION, "FL", JUN8)).rejects.toThrow(/session/);
  });

  it("rejects a non-zip binary served with a non-html type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(res(200, "not a zip", "application/octet-stream")),
    );
    await expect(downloadDrmZipWithSession(SESSION, "FL", JUN8)).rejects.toThrow(/not a zip/);
  });
});

describe("ingestForDate (session path)", () => {
  it("acquires a session, downloads with it, and persists the parsed card", async () => {
    process.env.BRISNET_USERNAME = "Ken6741";
    process.env.BRISNET_PASSWORD = "pw";
    getOrAcquireMock.mockResolvedValue(SESSION);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(res(200, fixtureAb(), "application/zip"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestForDate(JUN8, ["FL"], "manual");
    expect(getOrAcquireMock).toHaveBeenCalledWith("brisnet");
    expect(result.status).toBe("ok");
    const fl = result.results.find((r) => r.trackCode === "FL")!;
    expect(fl.status).toBe("ok");
    expect(fl.raceCount).toBe(8);
    expect(fl.horseCount ?? 0).toBeGreaterThan(0);
  });
});
