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
  if (
    opts?.debug ||
    process.env.BRISNET_DEBUG === "1" ||
    process.env.EQUIBASE_DEBUG === "1"
  ) {
    console.log("[browser-session]", ...args);
  }
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
// React SPA at /product/login (PR #30 recon): the form inputs don't exist in the
// DOM until hydration, so we wait for `networkidle` and then for the username
// field to actually render before filling. Login is a JS fetch, not a classic
// form POST; on success the SPA navigates away from /product/login to
// /product/. Akamai silently passes a real Chromium. Success marker: no longer
// on /product/login AND the account name (Ken6741) OR a logout link is present.
export async function acquireBrisnetSession(
  username: string,
  password: string,
  opts?: AcquireOpts,
): Promise<BrowserSession> {
  return withChromium(opts, async (context) => {
    const page = await context.newPage();
    debugLog(opts, "brisnet: navigating to login");
    await page.goto(BRISNET_LOGIN_URL, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Wait for the React-rendered username field to exist before filling — on a
    // domcontentloaded nav the inputs aren't in the DOM yet (PR #29's bug).
    await page.waitForSelector(
      'input[type="text"], input[name="username" i], input#username',
      { timeout: 10_000 },
    );

    const userField = page
      .locator(
        'input[name="Username" i], input[name="username"], input#username, input[type="text"]',
      )
      .first();
    const passField = page
      .locator(
        'input[name="Password" i], input[name="password"], input#password, input[type="password"]',
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

    const finalUrl = page.url();
    const onLoginPage = /\/product\/login/i.test(finalUrl);
    const hasLogout =
      (await page
        .locator(
          'a[href*="logout" i], a:has-text("Logout"), a:has-text("Log Out"), a:has-text("My Account")',
        )
        .count()) > 0;
    // The authenticated SPA renders the logged-in account name in the header.
    const hasAccountName =
      username.length > 0 &&
      (await page.locator(`text=${username}`).count().catch(() => 0)) > 0;

    // Capture page-visible error text if any — most React SPAs render server
    // validation errors into a div with role=alert or class containing "error".
    const errorText = await page
      .locator(
        '[role="alert"], .error, .alert, [class*="error" i], [class*="invalid" i]',
      )
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => "");

    debugLog(opts, "brisnet post-submit", {
      finalUrl,
      onLoginPage,
      hasLogout,
      hasAccountName,
      errorText: errorText.slice(0, 200),
    });

    if (onLoginPage) {
      throw new Error(
        `Brisnet login form re-rendered without navigating — credentials rejected ` +
          `or validation error. URL=${finalUrl}. Page error: ${errorText || "(none)"}`,
      );
    }
    if (!hasLogout && !hasAccountName) {
      throw new Error(
        `Brisnet navigated off /product/login but no logout/account marker found. ` +
          `URL=${finalUrl}. Selector may be stale — capture HTML via BRISNET_DEBUG=1.`,
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

    // Usercentrics CMP overlay (#uniccmp) intercepts pointer events on the
    // login form. Accept it before interacting with the form. The banner is
    // optional (returning users may not see it on Chromium first run? — debug
    // telemetry will show), so we tolerate it not appearing.
    try {
      // The banner renders inside #uniccmp; the accept button has stable text.
      const acceptBtn = page
        .locator(
          '#uniccmp button:has-text("Accept All"), ' +
            '#uniccmp button:has-text("Accept"), ' +
            '#uniccmp button:has-text("I Accept"), ' +
            '#uniccmp button:has-text("OK"), ' +
            '#uniccmp button:has-text("Agree"), ' +
            '#uniccmp button:has-text("Got it"), ' +
            '#uniccmp button[data-testid*="accept" i]',
        )
        .first();
      await acceptBtn.waitFor({ state: "visible", timeout: 5_000 });
      debugLog(opts, "equibase: dismissing Usercentrics consent banner");
      await acceptBtn.click({ timeout: 5_000 });
      // After click the banner should detach; wait for it to go away.
      await page
        .locator("#uniccmp")
        .waitFor({ state: "detached", timeout: 5_000 })
        .catch(() => {
          /* some CMPs hide rather than detach; if it's still in DOM but no longer
             intercepting pointer events, the next click will succeed regardless */
        });
    } catch (e) {
      debugLog(
        opts,
        "equibase: no Usercentrics banner found within 5s (already dismissed or different CMP variant)",
        (e as Error).message,
      );
    }

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

    // Recon confirmed a successful login lands on /index.cfm?&logon=Y. Treat
    // that as the primary success marker; fall back to an account/logout/
    // welcome affordance for any other authenticated landing page.
    const onLogonLanding = /logon=y/i.test(page.url());
    const hasLogout =
      (await page
        .locator(
          'a[href*="Logoff" i], a[href*="logout" i], a:has-text("Logout"), a:has-text("Sign Out"), a:has-text("My Account"), a:has-text("Welcome")',
        )
        .count()) > 0;
    const onLoginPage = /eebCustomerLogon\.cfm/i.test(page.url());
    if (!onLogonLanding && onLoginPage && !hasLogout) {
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
