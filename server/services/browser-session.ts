// Playwright-based authenticated browser session acquisition for the ingest
// upstreams (Brisnet + Equibase).
//
// Why this exists: PR #27 proved both logins are unreachable to a server-side
// `fetch`. Brisnet's Akamai Bot Manager silently drops non-browser TLS
// fingerprints; Equibase's Imperva/Incapsula JS challenge bounces any client
// that can't execute the challenge JS to eebErrorNoCookies.cfm. A real headless
// Chromium clears both. We drive the classic HTML login forms, wait for the
// authenticated landing page, then harvest the cookie jar + User-Agent so the
// existing fetch-based download paths can reuse them.
//
// The browser is ALWAYS closed in `finally` — a leaked Chromium process will
// OOM Railway's container within a few cron runs.
//
// Credentials are passed in by the caller (read from env there); this module
// never reads or logs them.

import { chromium, type Browser, type BrowserContext } from "playwright";

// Serialized Playwright cookie. Mirrors the subset of playwright's Cookie shape
// we persist + replay; kept local so callers don't depend on the playwright
// type surface and so the session-cache JSON round-trips cleanly.
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // unix seconds; -1 for session cookies
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export type SessionProvider = "brisnet" | "equibase";

export interface BrowserSession {
  cookies: SessionCookie[];
  userAgent: string;
  acquiredAt: Date;
  expiresAt?: Date; // best-effort from the longest-lived auth cookie max-age
  provider: SessionProvider;
}

export interface AcquireOpts {
  headless?: boolean;
  debug?: boolean;
}

// A current desktop Chrome UA on macOS. Both upstreams gate cookies / bot scores
// on the UA, and we replay this exact string on the subsequent fetch downloads
// so the session stays consistent with where it was minted.
export const SESSION_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const VIEWPORT = { width: 1440, height: 900 };

// Railway's container runs Chromium as root without user namespaces, so the
// sandbox can't be set up; --no-sandbox is required. --disable-dev-shm-usage
// avoids the tiny default /dev/shm crashing the renderer under memory pressure.
const LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];

const BRISNET_LOGIN_URL = "https://www.brisnet.com/product/login";
const EQUIBASE_LOGIN_URL =
  "https://www.equibase.com/premium/eebCustomerLogon.cfm";

function debugLog(opts: AcquireOpts | undefined, ...args: unknown[]): void {
  if (opts?.debug) console.log("[browser-session]", ...args);
}

// Akamai (Brisnet) and Imperva (Equibase) both score input cadence — instant
// field population reads as automation. A random human-ish pause between fills
// keeps the timing profile plausible.
function humanDelay(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 600); // 200-800ms
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pick the latest expiry across the harvested cookies as a conservative session
// lifetime hint. Session cookies (expires === -1) are ignored. Returns undefined
// when nothing has a concrete expiry.
export function deriveExpiresAt(cookies: SessionCookie[]): Date | undefined {
  let maxSec = 0;
  for (const c of cookies) {
    if (typeof c.expires === "number" && c.expires > maxSec) maxSec = c.expires;
  }
  return maxSec > 0 ? new Date(maxSec * 1000) : undefined;
}

// Shared launch + login driver. The per-provider functions supply the login URL
// and a `login` callback that fills the form on an already-navigated page and
// resolves once the authenticated state is confirmed (or throws on failure).
async function withChromium<T>(
  opts: AcquireOpts | undefined,
  fn: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: opts?.headless ?? true,
      args: LAUNCH_ARGS,
    });
    const context = await browser.newContext({
      userAgent: SESSION_USER_AGENT,
      viewport: VIEWPORT,
    });
    return await fn(context);
  } finally {
    // Always tear the browser down — a leaked process OOMs Railway.
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* best-effort: the launch may have failed before close is meaningful */
      }
    }
  }
}

async function harvest(
  context: BrowserContext,
  provider: SessionProvider,
): Promise<BrowserSession> {
  const raw = await context.cookies();
  const cookies: SessionCookie[] = raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
  return {
    cookies,
    userAgent: SESSION_USER_AGENT,
    acquiredAt: new Date(),
    expiresAt: deriveExpiresAt(cookies),
    provider,
  };
}

// ── Brisnet ──────────────────────────────────────────────────────────────────
// Classic HTML form at /product/login: text input[name=Username], password
// input[name=Password], submit button. Confirmed by 2026-06-08 recon. Success
// is leaving the login page and exposing a logout/account affordance.
export async function acquireBrisnetSession(
  username: string,
  password: string,
  opts?: AcquireOpts,
): Promise<BrowserSession> {
  return withChromium(opts, async (context) => {
    const page = await context.newPage();
    debugLog(opts, "brisnet: navigating to login");
    await page.goto(BRISNET_LOGIN_URL, { waitUntil: "domcontentloaded" });

    const userField = page
      .locator(
        'input[name="Username" i], input[name="username"], input#username',
      )
      .first();
    const passField = page
      .locator(
        'input[name="Password" i], input[name="password"], input#password',
      )
      .first();

    await humanDelay();
    await userField.fill(username);
    await humanDelay();
    await passField.fill(password);
    await humanDelay();

    const loginButton = page
      .locator(
        'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Log In")',
      )
      .first();
    if ((await loginButton.count()) === 0) {
      throw new Error(
        "Brisnet login button not found — selector changed (check brisnet.com/product/login HTML)",
      );
    }
    await loginButton.click();

    await page.waitForLoadState("networkidle").catch(() => {
      /* networkidle can time out on chatty analytics; the marker probe below is
         the real success gate */
    });

    const onLoginPage = /\/product\/login/i.test(page.url());
    const hasLogout =
      (await page
        .locator(
          'a[href*="logout" i], a:has-text("Logout"), a:has-text("Log Out"), a:has-text("My Account")',
        )
        .count()) > 0;
    if (onLoginPage && !hasLogout) {
      throw new Error(
        "Brisnet login did not reach an authenticated page (still on /product/login; " +
          "credentials rejected or Akamai challenge tightened)",
      );
    }

    return harvest(context, "brisnet");
  });
}

// ── Equibase ───────────────────────────────────────────────────────────────
// ColdFusion login form posts user_id / customer_password / continue_button to
// eebCustomerLogonAction.cfm. We fill the visible form and submit; Incapsula's
// JS challenge is cleared by the real browser before/at navigation. Success is
// NOT landing on eebErrorNoCookies.cfm and exposing a logout affordance.
export async function acquireEquibaseSession(
  username: string,
  password: string,
  opts?: AcquireOpts,
): Promise<BrowserSession> {
  return withChromium(opts, async (context) => {
    const page = await context.newPage();
    debugLog(opts, "equibase: navigating to login");
    await page.goto(EQUIBASE_LOGIN_URL, { waitUntil: "domcontentloaded" });

    const userField = page
      .locator('input[name="user_id"], input#user_id')
      .first();
    const passField = page
      .locator(
        'input[name="customer_password"], input[type="password"], input#customer_password',
      )
      .first();

    await humanDelay();
    await userField.fill(username);
    await humanDelay();
    await passField.fill(password);
    await humanDelay();

    const submit = page
      .locator(
        'input[name="continue_button"], input[type="submit"], button[type="submit"], button:has-text("Continue")',
      )
      .first();
    if ((await submit.count()) === 0) {
      throw new Error(
        "Equibase continue button not found — selector changed (check eebCustomerLogon.cfm HTML)",
      );
    }
    await submit.click();

    await page.waitForLoadState("networkidle").catch(() => {
      /* see brisnet note */
    });

    if (/eebErrorNoCookies\.cfm/i.test(page.url())) {
      throw new Error(
        "Equibase still showing eebErrorNoCookies.cfm even after Playwright — " +
          "Incapsula challenge tightened; may need playwright-extra + " +
          "puppeteer-extra-plugin-stealth (follow-up PR)",
      );
    }

    const hasLogout =
      (await page
        .locator(
          'a[href*="Logoff" i], a[href*="logout" i], a:has-text("Logout"), a:has-text("Sign Out"), a:has-text("My Account")',
        )
        .count()) > 0;
    const onLoginPage = /eebCustomerLogon\.cfm/i.test(page.url());
    if (onLoginPage && !hasLogout) {
      throw new Error(
        "Equibase login did not reach an authenticated page (still on " +
          "eebCustomerLogon.cfm; credentials rejected)",
      );
    }

    return harvest(context, "equibase");
  });
}

// Serialize a harvested cookie jar to the `name=value; name=value` Cookie header
// string the fetch-based download paths send. Domain/path filtering is the
// caller's concern; for our single-host-per-provider downloads, all harvested
// cookies are in scope.
export function cookieHeaderFrom(cookies: SessionCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
