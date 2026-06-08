import { describe, it, expect, afterEach, vi } from "vitest";
import {
  formatRaceDateParam,
  mmdd,
  ymd,
  ppFilename,
  buildDownloadUrl,
  parseAvailableTracks,
  parseSetCookies,
  loginEquibase,
} from "../services/equibase-ingest";
import {
  boiseSixAmUtcHour,
  msUntilNextSixAmBoise,
} from "../services/equibase-cron";
import { boiseSevenAmUtcHour } from "../services/show-cron";

// June 8 2026 — the discovery-report reference date (Finger Lakes, FL0608FPP).
const JUN8 = new Date(2026, 5, 8);

describe("date + filename helpers", () => {
  it("formats the raceDate query param as MM/DD/YYYY", () => {
    expect(formatRaceDateParam(JUN8)).toBe("06/08/2026");
    expect(formatRaceDateParam(new Date(2026, 11, 3))).toBe("12/03/2026");
  });

  it("zero-pads MMDD and YYYYMMDD", () => {
    expect(mmdd(JUN8)).toBe("0608");
    expect(ymd(JUN8)).toBe("20260608");
    expect(mmdd(new Date(2026, 0, 1))).toBe("0101");
  });

  it("builds the PP filename {TRACK}{MMDD}FPP.PDF, uppercased", () => {
    expect(ppFilename("FL", JUN8)).toBe("FL0608FPP.PDF");
    expect(ppFilename("cd", new Date(2026, 5, 13))).toBe("CD0613FPP.PDF");
  });
});

describe("buildDownloadUrl", () => {
  it("matches the discovered subscription download pattern exactly", () => {
    const url = buildDownloadUrl("FL", JUN8, "88593127");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      "https://www.equibase.com/premium/eebDownloadFPPProgram.cfm",
    );
    expect(u.searchParams.get("transid")).toBe("88593127");
    expect(u.searchParams.get("product_id")).toBe("50300");
    expect(u.searchParams.get("sequence")).toBe("1");
    expect(u.searchParams.get("filename")).toBe("FL0608FPP.PDF");
  });

  it("uppercases the track code in the filename", () => {
    const u = new URL(buildDownloadUrl("gp", JUN8, "1"));
    expect(u.searchParams.get("filename")).toBe("GP0608FPP.PDF");
  });
});

describe("parseAvailableTracks", () => {
  // Synthetic PP-page HTML modeling the subscriber download links. The transid
  // is a placeholder — no real session data or credentials in the fixture.
  const HTML = `
    <html><body>
      <table id="ppTracks">
        <tr>
          <td><a href="eebDownloadFPPProgram.cfm?transid=11110000&product_id=50300&sequence=1&filename=FL0608FPP.PDF">Finger Lakes</a></td>
        </tr>
        <tr>
          <td><a href="/premium/eebDownloadFPPProgram.cfm?transid=11110001&product_id=50300&sequence=1&filename=GP0608FPP.PDF">Gulfstream Park</a></td>
        </tr>
        <tr>
          <td><a href="https://www.equibase.com/premium/eebDownloadFPPProgram.cfm?transid=11110002&product_id=50300&sequence=1&filename=LRL0608FPP.PDF">Laurel Park</a></td>
        </tr>
        <!-- non-subscriber add-to-cart link must be ignored -->
        <tr>
          <td><a href="eebURLAddToCart.cfm?pid=50300&pfn=IND0610FPP.pdf">Indiana (buy)</a></td>
        </tr>
      </table>
    </body></html>`;

  it("extracts one entry per subscription download link", () => {
    const tracks = parseAvailableTracks(HTML);
    expect(tracks.map((t) => t.trackCode)).toEqual(["FL", "GP", "LRL"]);
  });

  it("captures transid, track name, and a normalized absolute download URL", () => {
    const fl = parseAvailableTracks(HTML).find((t) => t.trackCode === "FL")!;
    expect(fl.transid).toBe("11110000");
    expect(fl.trackName).toBe("Finger Lakes");
    expect(fl.downloadUrl).toContain(
      "https://www.equibase.com/premium/eebDownloadFPPProgram.cfm",
    );
    expect(fl.downloadUrl).toContain("filename=FL0608FPP.PDF");
  });

  it("ignores add-to-cart (non-subscriber) links", () => {
    const codes = parseAvailableTracks(HTML).map((t) => t.trackCode);
    expect(codes).not.toContain("IND");
  });

  it("dedupes a track that appears twice", () => {
    const dup = HTML.replace(
      "</table>",
      `<tr><td><a href="eebDownloadFPPProgram.cfm?transid=9&product_id=50300&sequence=1&filename=FL0608FPP.PDF">Finger Lakes again</a></td></tr></table>`,
    );
    const fls = parseAvailableTracks(dup).filter((t) => t.trackCode === "FL");
    expect(fls).toHaveLength(1);
  });

  it("returns empty for HTML with no PP links", () => {
    expect(parseAvailableTracks("<html><body>No tracks today</body></html>")).toEqual([]);
  });
});

describe("parseSetCookies", () => {
  it("pulls name=value pairs and drops attributes", () => {
    const jar = parseSetCookies([
      "CFID=12345; path=/; HttpOnly",
      "CFTOKEN=abcdef0123; path=/; Secure",
      "JSESSIONID=ZZZ; path=/",
    ]);
    expect(jar.get("CFID")).toBe("12345");
    expect(jar.get("CFTOKEN")).toBe("abcdef0123");
    expect(jar.get("JSESSIONID")).toBe("ZZZ");
  });

  it("ignores malformed cookie lines", () => {
    const jar = parseSetCookies(["", "novalue", "=orphan"]);
    expect(jar.size).toBe(0);
  });
});

describe("loginEquibase redirect-chain cookie capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Build a Headers whose getSetCookie() returns the given lines, plus an
  // optional Location, mirroring node's undici Headers behavior.
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
  ): Response {
    const res = {
      status,
      headers: makeHeaders(setCookies, location),
      clone: () => makeResponse(status, setCookies, location, body),
      text: async () => body,
    };
    return res as unknown as Response;
  }

  it("captures Set-Cookie that arrives on the 302 hop, not the final 200", async () => {
    // Hop 0: POST -> 302 with CFID/CFTOKEN on the redirect, Location to landing.
    // Hop 1: GET landing -> 200 with JSESSIONID and no further redirect.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeResponse(
          302,
          ["CFID=12345; path=/; HttpOnly", "CFTOKEN=abcdef0123; path=/"],
          "https://www.equibase.com/premium/landing.cfm",
        ),
      )
      .mockResolvedValueOnce(
        makeResponse(200, ["JSESSIONID=ZZZ; path=/"]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const jar = await loginEquibase("user", "pass");
    expect(jar.get("CFID")).toBe("12345");
    expect(jar.get("CFTOKEN")).toBe("abcdef0123");
    expect(jar.get("JSESSIONID")).toBe("ZZZ");

    // Second hop must carry the cookies gathered on the first hop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Cookie).toContain(
      "CFID=12345",
    );
    expect(secondInit.method).toBe("GET");
  });

  it("sends a browser User-Agent on the login POST", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(200, ["CFID=1; path=/"]));
    vi.stubGlobal("fetch", fetchMock);
    await loginEquibase("user", "pass");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const ua = (init.headers as Record<string, string>)["User-Agent"];
    expect(ua).toContain("Chrome/");
    expect(ua).not.toContain("EEA-Dashboard");
  });

  it("throws when no session cookie is set across any hop", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeResponse(200, ["foo=bar; path=/"]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loginEquibase("user", "pass")).rejects.toThrow(
      /did not set a session cookie/,
    );
  });

  it("stops following redirects after MAX_LOGIN_HOPS", async () => {
    // Always 302 to itself, never setting a session cookie -> must terminate.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeResponse(302, [], "https://www.equibase.com/premium/loop.cfm"),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(loginEquibase("user", "pass")).rejects.toThrow(
      /did not set a session cookie/,
    );
    // 1 POST + up to MAX_LOGIN_HOPS GETs; never unbounded.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe("6am Boise scheduling", () => {
  it("is exactly one hour before the 7am-Boise UTC hour", () => {
    const now = new Date();
    expect(boiseSixAmUtcHour(now)).toBe((boiseSevenAmUtcHour(now) + 23) % 24);
  });

  it("computes 12:00 UTC in summer MDT (UTC-6)", () => {
    // June -> MDT, 6am local = 12:00 UTC.
    expect(boiseSixAmUtcHour(new Date(Date.UTC(2026, 5, 8, 18, 0, 0)))).toBe(12);
  });

  it("always returns a strictly-future delay within ~24h", () => {
    const ms = msUntilNextSixAmBoise(new Date());
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
  });
});
