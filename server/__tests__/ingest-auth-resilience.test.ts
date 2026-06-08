// PR #27 Part B4 — ingest auth resilience. Three tests proving the empirical
// B1 findings are handled cleanly instead of faking success:
//   1. Equibase login that returns 200 with NO session cookie → clean error.
//   2. Brisnet login POST that gets 405 with an Allow header excluding POST →
//      a clean "endpoint no longer accepts POST" error, with NO POST retry.
//   3. (frontend) PullCardModal renders a structured per-source error — see
//      client/src/components/PullCardModal.test.tsx for the jsdom render test.

import { describe, it, expect, vi, afterEach } from "vitest";
import { loginEquibase } from "../services/equibase-ingest";
import { loginBrisnet } from "../services/brisnet-ingest";

// Build a minimal Response-like object with a getSetCookie()-capable Headers.
function mockResponse(opts: {
  status: number;
  setCookies?: string[];
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const h = new Headers(opts.headers ?? {});
  // jsdom/undici Headers has getSetCookie; in node test env we shim it.
  (h as Headers & { getSetCookie?: () => string[] }).getSetCookie = () =>
    opts.setCookies ?? [];
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: h,
    text: async () => opts.body ?? "",
    clone() {
      return this as unknown as Response;
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Equibase login — 200 with no session cookie is a clean failure", () => {
  it("throws an actionable error and never returns an empty jar", async () => {
    // GET form → seeds only Incapsula/CMP cookies (no CF session).
    // POST action → 200 HTML, still no CFID/CFTOKEN/JSESSIONID (the bot-wall).
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockResponse({ status: 200, setCookies: ["COOKIE_TEST=1", "visid_incap_2434933=x"] }),
      )
      .mockResolvedValueOnce(
        mockResponse({ status: 200, setCookies: ["incap_ses_1844_2434933=y"], body: "<html>login</html>" }),
      );

    await expect(loginEquibase("Ken6741", "pw")).rejects.toThrow(/session cookie/i);
    // GET form + POST action = 2 calls; no infinite redirect chasing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("detects the Incapsula eebErrorNoCookies redirect explicitly", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse({ status: 200, setCookies: ["COOKIE_TEST=1"] }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 302,
          headers: { location: "eebErrorNoCookies.cfm" },
          setCookies: ["incap_ses_1844_2434933=y"],
        }),
      );

    await expect(loginEquibase("Ken6741", "pw")).rejects.toThrow(/bot protection|Incapsula/i);
  });
});

describe("Brisnet login — 405 with Allow header is reported, not retried as POST", () => {
  it("throws a clean 'endpoint no longer accepts POST' error on 405/Allow: GET,HEAD,OPTIONS", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        status: 405,
        headers: { allow: "GET, HEAD, OPTIONS" },
        setCookies: ["ak_bmsc=z"],
        body: "<html><h1>405 Method Not Allowed</h1></html>",
      }),
    );

    await expect(loginBrisnet("Ken6741", "pw")).rejects.toThrow(/no longer accepts POST|405/i);
    // Exactly one POST attempt — we do NOT hammer a method the server rejects.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
  });
});
