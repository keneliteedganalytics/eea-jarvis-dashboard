// Manual session smoke runner (PR #30).
//
// Calls acquireBrisnetSession + acquireEquibaseSession DIRECTLY with the env
// credentials and reports, per provider: success/failure, the cookie names
// harvested (never values), and elapsed time. It does NOT download any cards —
// it only proves the login + cookie-jar plumbing works against the live sites.
//
// Do NOT run from CI: repeated logins from a data-center IP raise Akamai's /
// Imperva's bot score. Run locally or on the Railway shell:
//
//   BRISNET_USER=... BRISNET_PASS=... \
//   EQUIBASE_USER=... EQUIBASE_PASS=... \
//   npm run verify:session
//   # optional: SESSION_DEBUG=1 for the per-step browser log
//
// Exit code is 0 only if BOTH sessions were acquired.

import "dotenv/config";
import {
  acquireBrisnetSession,
  acquireEquibaseSession,
  type BrowserSession,
} from "../server/services/browser-session";

const debug = process.env.SESSION_DEBUG === "1";

async function attempt(
  label: string,
  fn: () => Promise<BrowserSession>,
): Promise<boolean> {
  const started = Date.now();
  try {
    const session = await fn();
    const elapsedMs = Date.now() - started;
    console.log(`[verify:${label}] OK in ${elapsedMs}ms`, {
      cookieNames: session.cookies.map((c) => c.name),
      userAgent: session.userAgent,
      expiresAt: session.expiresAt?.toISOString() ?? "(session cookies only)",
    });
    return true;
  } catch (err) {
    const elapsedMs = Date.now() - started;
    console.error(
      `[verify:${label}] FAILED in ${elapsedMs}ms:`,
      (err as Error).message,
    );
    return false;
  }
}

async function main(): Promise<void> {
  const brisUser = process.env.BRISNET_USER || process.env.BRISNET_USERNAME;
  const brisPass = process.env.BRISNET_PASS || process.env.BRISNET_PASSWORD;
  const eqUser = process.env.EQUIBASE_USER || process.env.EQUIBASE_USERNAME;
  const eqPass = process.env.EQUIBASE_PASS || process.env.EQUIBASE_PASSWORD;

  let brisOk = false;
  if (brisUser && brisPass) {
    brisOk = await attempt("brisnet", () =>
      acquireBrisnetSession(brisUser, brisPass, { headless: true, debug }),
    );
  } else {
    console.error("[verify:brisnet] SKIPPED — BRISNET_USER / BRISNET_PASS not set");
  }

  let eqOk = false;
  if (eqUser && eqPass) {
    eqOk = await attempt("equibase", () =>
      acquireEquibaseSession(eqUser, eqPass, { headless: true, debug }),
    );
  } else {
    console.error("[verify:equibase] SKIPPED — EQUIBASE_USER / EQUIBASE_PASS not set");
  }

  process.exit(brisOk && eqOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify:session] FAILED:", err);
  process.exit(1);
});
