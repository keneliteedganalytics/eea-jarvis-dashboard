import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";

const TMP_DB = path.join(os.tmpdir(), `eea-equi-pw-${Date.now()}.db`);
const TMP_PP = path.join(os.tmpdir(), `eea-equi-pw-pp-${Date.now()}`);
process.env.DATABASE_FILE = TMP_DB;
process.env.EQUIBASE_PP_DIR = TMP_PP;

// Hoisted session-cache mock so equibase-ingest's orchestration never launches
// a real browser.
const getOrAcquireMock = vi.fn();
const invalidateMock = vi.fn();
vi.mock("../services/session-cache", () => ({
  getOrAcquire: (...a: unknown[]) => getOrAcquireMock(...a),
  invalidate: (...a: unknown[]) => invalidateMock(...a),
}));

import {
  listAvailableTracksWithSession,
  downloadPPWithSession,
  type AvailableTrack,
} from "../services/equibase-ingest";
import type { BrowserSession } from "../services/browser-session";

const JUN9 = new Date(2026, 5, 9);

const SESSION: BrowserSession = {
  cookies: [
    { name: "CFID", value: "111", domain: ".equibase.com", path: "/", expires: -1, httpOnly: true, secure: true },
    { name: "CFTOKEN", value: "tok", domain: ".equibase.com", path: "/", expires: -1, httpOnly: true, secure: true },
  ],
  userAgent: "Mozilla/5.0 EquiTestUA Chrome/120",
  acquiredAt: new Date(),
  provider: "equibase",
};

// Minimal Full PP listing page with one Finger Lakes download link.
const PP_HTML = `
<html><body>
<a href="eebDownloadFPPProgram.cfm?transid=TX42&product_id=50300&sequence=1&filename=FL0609FPP.pdf">Finger Lakes</a>
</body></html>`;

function textRes(status: number, body: string): Response {
  const headers = new Headers();
  headers.set("content-type", "text/html");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => body,
  } as unknown as Response;
}

function binRes(status: number, body: string): Response {
  const headers = new Headers();
  headers.set("content-type", "application/pdf");
  const ab = new TextEncoder().encode(body).buffer as ArrayBuffer;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    arrayBuffer: async () => ab,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listAvailableTracksWithSession", () => {
  it("sends cookies + UA and scrapes the download links", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(textRes(200, PP_HTML));
    vi.stubGlobal("fetch", fetchMock);

    const tracks = await listAvailableTracksWithSession(SESSION, JUN9);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].trackCode).toBe("FL");
    expect(tracks[0].transid).toBe("TX42");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toContain("CFID=111");
    expect(headers.Cookie).toContain("CFTOKEN=tok");
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 EquiTestUA Chrome/120");
  });

  it("throws on a non-OK PP page", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(textRes(500, "")));
    await expect(listAvailableTracksWithSession(SESSION, JUN9)).rejects.toThrow(/PP page HTTP 500/);
  });
});

describe("downloadPPWithSession", () => {
  const track: AvailableTrack = {
    trackCode: "FL",
    trackName: "Finger Lakes",
    transid: "TX42",
    downloadUrl:
      "https://www.equibase.com/premium/eebDownloadFPPProgram.cfm?transid=TX42&product_id=50300&sequence=1&filename=FL0609FPP.pdf",
  };

  it("writes a valid PDF using the session cookies + UA", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(binRes(200, "%PDF-1.4\nfake pdf body"));
    vi.stubGlobal("fetch", fetchMock);

    const dl = await downloadPPWithSession(SESSION, track, JUN9);
    expect(dl.byteCount).toBeGreaterThan(0);
    expect(dl.pdfPath).toContain("FL.pdf");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toContain("CFID=111");
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 EquiTestUA Chrome/120");
  });

  it("rejects a non-PDF body (HTML error page served as a download)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(binRes(200, "<html>nope</html>")),
    );
    await expect(downloadPPWithSession(SESSION, track, JUN9)).rejects.toThrow(/not a PDF/);
  });

  it("rejects a non-OK download", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(binRes(403, "")));
    await expect(downloadPPWithSession(SESSION, track, JUN9)).rejects.toThrow(/download HTTP 403/);
  });
});
