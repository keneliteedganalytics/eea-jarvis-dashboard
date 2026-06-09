import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock playwright BEFORE importing the module under test ────────────────────
// A tiny fake of the chromium -> browser -> context -> page chain. Each test
// configures the fake's behavior (cookies returned, page URL after submit,
// presence of the logout marker) through the shared `state` object.
interface FakeState {
  cookies: Array<Record<string, unknown>>;
  urlAfterSubmit: string;
  logoutCount: number;
  buttonCount: number;
  launchThrows?: Error;
  closed: boolean;
  filled: Record<string, string>;
  clicked: boolean;
}

const state: FakeState = {
  cookies: [],
  urlAfterSubmit: "",
  logoutCount: 0,
  buttonCount: 1,
  closed: false,
  filled: {},
  clicked: false,
};

function makeLocator(selector: string) {
  return {
    first() {
      return this;
    },
    async fill(value: string) {
      state.filled[selector] = value;
    },
    async click() {
      state.clicked = true;
    },
    async count() {
      // Logout/account markers
      if (/logout|logoff|My Account|Sign Out/i.test(selector)) {
        return state.logoutCount;
      }
      // Submit/login button
      if (/submit|Login|Log In|Continue|continue_button/i.test(selector)) {
        return state.buttonCount;
      }
      return 1;
    },
  };
}

function makePage() {
  let currentUrl = "about:blank";
  return {
    async goto(url: string) {
      currentUrl = url;
    },
    url() {
      // After a click, the page is on the post-submit URL.
      return state.clicked ? state.urlAfterSubmit : currentUrl;
    },
    locator(selector: string) {
      return makeLocator(selector);
    },
    async waitForLoadState() {
      /* resolve immediately */
    },
  };
}

const launchMock = vi.fn(async () => {
  if (state.launchThrows) throw state.launchThrows;
  return {
    async newContext() {
      return {
        async newPage() {
          return makePage();
        },
        async cookies() {
          return state.cookies;
        },
      };
    },
    async close() {
      state.closed = true;
    },
  };
});

vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launchMock(...args) },
}));

import {
  acquireBrisnetSession,
  acquireEquibaseSession,
  deriveExpiresAt,
  cookieHeaderFrom,
  SESSION_USER_AGENT,
  type SessionCookie,
} from "../services/browser-session";

function resetState(overrides: Partial<FakeState> = {}) {
  state.cookies = [];
  state.urlAfterSubmit = "";
  state.logoutCount = 0;
  state.buttonCount = 1;
  state.launchThrows = undefined;
  state.closed = false;
  state.filled = {};
  state.clicked = false;
  Object.assign(state, overrides);
}

const COOKIE = (over: Partial<SessionCookie> = {}): Record<string, unknown> => ({
  name: "PHPSESSID",
  value: "abc123",
  domain: ".brisnet.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...over,
});

beforeEach(() => {
  resetState();
  launchMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("deriveExpiresAt", () => {
  it("picks the latest concrete expiry and ignores session cookies", () => {
    const cookies: SessionCookie[] = [
      { name: "a", value: "1", domain: "d", path: "/", expires: -1, httpOnly: false, secure: false },
      { name: "b", value: "2", domain: "d", path: "/", expires: 2000, httpOnly: false, secure: false },
      { name: "c", value: "3", domain: "d", path: "/", expires: 5000, httpOnly: false, secure: false },
    ];
    expect(deriveExpiresAt(cookies)).toEqual(new Date(5000 * 1000));
  });

  it("returns undefined when every cookie is a session cookie", () => {
    const cookies: SessionCookie[] = [
      { name: "a", value: "1", domain: "d", path: "/", expires: -1, httpOnly: false, secure: false },
    ];
    expect(deriveExpiresAt(cookies)).toBeUndefined();
  });
});

describe("cookieHeaderFrom", () => {
  it("serializes name=value pairs joined by '; '", () => {
    const cookies: SessionCookie[] = [
      { name: "CFID", value: "10", domain: "d", path: "/", expires: -1, httpOnly: false, secure: false },
      { name: "CFTOKEN", value: "zz", domain: "d", path: "/", expires: -1, httpOnly: false, secure: false },
    ];
    expect(cookieHeaderFrom(cookies)).toBe("CFID=10; CFTOKEN=zz");
  });
});

describe("acquireBrisnetSession", () => {
  it("returns a session with cookies + UA and closes the browser", async () => {
    resetState({
      cookies: [COOKIE({ expires: 9999999999 })],
      urlAfterSubmit: "https://www.brisnet.com/product/account",
      logoutCount: 1,
    });
    const session = await acquireBrisnetSession("Ken6741", "pw!", { headless: true });
    expect(session.provider).toBe("brisnet");
    expect(session.userAgent).toBe(SESSION_USER_AGENT);
    expect(session.cookies[0].name).toBe("PHPSESSID");
    expect(session.expiresAt).toEqual(new Date(9999999999 * 1000));
    expect(state.closed).toBe(true);
    // Credentials were filled into the user + password fields.
    expect(Object.values(state.filled)).toContain("Ken6741");
    expect(Object.values(state.filled)).toContain("pw!");
  });

  it("launches headless with --no-sandbox + --disable-dev-shm-usage", async () => {
    resetState({
      cookies: [COOKIE()],
      urlAfterSubmit: "https://www.brisnet.com/product/account",
      logoutCount: 1,
    });
    await acquireBrisnetSession("u", "p");
    const arg = launchMock.mock.calls[0][0] as { headless: boolean; args: string[] };
    expect(arg.headless).toBe(true);
    expect(arg.args).toContain("--no-sandbox");
    expect(arg.args).toContain("--disable-dev-shm-usage");
  });

  it("throws (and still closes) when still on the login page with no logout marker", async () => {
    resetState({
      cookies: [],
      urlAfterSubmit: "https://www.brisnet.com/product/login",
      logoutCount: 0,
    });
    await expect(acquireBrisnetSession("u", "bad")).rejects.toThrow(
      /did not reach an authenticated page/,
    );
    expect(state.closed).toBe(true);
  });

  it("throws when the login button is missing", async () => {
    resetState({
      buttonCount: 0,
      urlAfterSubmit: "https://www.brisnet.com/product/login",
    });
    await expect(acquireBrisnetSession("u", "p")).rejects.toThrow(
      /login button not found/,
    );
    expect(state.closed).toBe(true);
  });

  it("closes the browser even when launch-side work throws mid-flow", async () => {
    // Simulate cookies() never being reached because we reject on the marker
    // check; the finally block must still have closed the browser.
    resetState({
      urlAfterSubmit: "https://www.brisnet.com/product/login",
      logoutCount: 0,
    });
    await expect(acquireBrisnetSession("u", "p")).rejects.toThrow();
    expect(state.closed).toBe(true);
  });
});

describe("acquireEquibaseSession", () => {
  it("succeeds when redirected to an authenticated page", async () => {
    resetState({
      cookies: [COOKIE({ name: "CFID", value: "55", domain: ".equibase.com" })],
      urlAfterSubmit: "https://www.equibase.com/premium/eqpEquibaseFullPP.cfm",
      logoutCount: 1,
    });
    const session = await acquireEquibaseSession("Ken6741", "pw");
    expect(session.provider).toBe("equibase");
    expect(session.cookies[0].name).toBe("CFID");
  });

  it("throws the Incapsula-specific error on eebErrorNoCookies.cfm", async () => {
    resetState({
      urlAfterSubmit: "https://www.equibase.com/premium/eebErrorNoCookies.cfm",
      logoutCount: 0,
    });
    await expect(acquireEquibaseSession("u", "p")).rejects.toThrow(
      /eebErrorNoCookies\.cfm/,
    );
    expect(state.closed).toBe(true);
  });

  it("throws when stranded on the logon page without a logout marker", async () => {
    resetState({
      urlAfterSubmit: "https://www.equibase.com/premium/eebCustomerLogon.cfm",
      logoutCount: 0,
    });
    await expect(acquireEquibaseSession("u", "bad")).rejects.toThrow(
      /did not reach an authenticated page/,
    );
  });
});
