// DB-backed reuse of authenticated browser sessions.
//
// Acquiring a Playwright session is expensive (cold-start Chromium + a real
// login round-trip) and — more importantly — repeated logins from a data-center
// IP raise the upstreams' bot scores. So we mint a session once and reuse its
// cookies for every download until it ages out. The jar is persisted to
// provider_sessions so a process restart (or the next cron) reuses a still-valid
// session rather than logging in again.
//
// Concurrency: getOrAcquire single-flights per provider — if a Brisnet download
// and an Equibase-then-Brisnet chain both ask at once, only one Chromium launch
// happens and both callers await the same promise.

import { sqlite } from "../db";
import {
  acquireBrisnetSession,
  acquireEquibaseSession,
  type AcquireOpts,
  type BrowserSession,
  type SessionCookie,
  type SessionProvider,
} from "./browser-session";

// Cookies typically last ~24h, but be conservative: re-mint every 6h so a long
// racing day never serves a download on a session that silently expired.
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

// Idempotent migration: single-row-per-provider session store. Guarded so a
// fresh install and an existing DB both converge without drizzle-kit.
export function ensureSessionTable(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS provider_sessions (
  provider TEXT PRIMARY KEY,
  cookies_json TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT
);`);
}
ensureSessionTable();

// In-flight acquisitions, keyed by provider, for single-flight dedup.
const inflight = new Map<SessionProvider, Promise<BrowserSession>>();

interface Row {
  provider: SessionProvider;
  cookies_json: string;
  user_agent: string;
  acquired_at: string;
  expires_at: string | null;
}

function readRow(provider: SessionProvider): BrowserSession | null {
  const row = sqlite
    .prepare(
      "SELECT provider, cookies_json, user_agent, acquired_at, expires_at FROM provider_sessions WHERE provider = ?",
    )
    .get(provider) as Row | undefined;
  if (!row) return null;
  let cookies: SessionCookie[];
  try {
    cookies = JSON.parse(row.cookies_json) as SessionCookie[];
  } catch {
    return null; // corrupt row — treat as a miss and re-acquire
  }
  return {
    cookies,
    userAgent: row.user_agent,
    acquiredAt: new Date(row.acquired_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    provider: row.provider,
  };
}

function writeRow(session: BrowserSession): void {
  sqlite
    .prepare(
      `INSERT INTO provider_sessions (provider, cookies_json, user_agent, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider) DO UPDATE SET
         cookies_json = excluded.cookies_json,
         user_agent   = excluded.user_agent,
         acquired_at  = excluded.acquired_at,
         expires_at   = excluded.expires_at`,
    )
    .run(
      session.provider,
      JSON.stringify(session.cookies),
      session.userAgent,
      session.acquiredAt.toISOString(),
      session.expiresAt ? session.expiresAt.toISOString() : null,
    );
}

// A cached session is fresh if it's younger than our TTL AND any cookie-derived
// expiry is still in the future. The TTL is the conservative floor; the cookie
// expiry is the hard ceiling.
export function isFresh(session: BrowserSession, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - session.acquiredAt.getTime();
  if (ageMs >= SESSION_TTL_MS) return false;
  if (session.expiresAt && session.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

// Resolve the credentials + acquire function for a provider. Reads BOTH the
// canonical *_USERNAME/*_PASSWORD names and falls back to *_USER/*_PASS to match
// the dual naming the ingest modules already accept.
function providerConfig(provider: SessionProvider): {
  username: string | undefined;
  password: string | undefined;
  acquire: (u: string, p: string, o?: AcquireOpts) => Promise<BrowserSession>;
} {
  if (provider === "brisnet") {
    return {
      username: process.env.BRISNET_USERNAME || process.env.BRISNET_USER,
      password: process.env.BRISNET_PASSWORD || process.env.BRISNET_PASS,
      acquire: acquireBrisnetSession,
    };
  }
  return {
    username: process.env.EQUIBASE_USERNAME || process.env.EQUIBASE_USER,
    password: process.env.EQUIBASE_PASSWORD || process.env.EQUIBASE_PASS,
    acquire: acquireEquibaseSession,
  };
}

// Return a fresh session for the provider, acquiring one if the cache is empty
// or stale. Concurrent calls for the same provider share one acquisition.
//
// `opts.force` bypasses the cache (used by smoke scripts). `opts` is otherwise
// forwarded to the Playwright acquire call (headless/debug).
export async function getOrAcquire(
  provider: SessionProvider,
  opts?: AcquireOpts & { force?: boolean },
): Promise<BrowserSession> {
  if (!opts?.force) {
    const cached = readRow(provider);
    if (cached && isFresh(cached)) return cached;
  }

  const existing = inflight.get(provider);
  if (existing) return existing;

  const { username, password, acquire } = providerConfig(provider);
  const promise = (async () => {
    if (!username || !password) {
      const envName =
        provider === "brisnet"
          ? "BRISNET_USERNAME / BRISNET_PASSWORD"
          : "EQUIBASE_USERNAME / EQUIBASE_PASSWORD";
      throw new Error(`${envName} not set — cannot acquire ${provider} session`);
    }
    const session = await acquire(username, password, opts);
    writeRow(session);
    return session;
  })();

  inflight.set(provider, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(provider);
  }
}

// Drop the cached session for a provider (e.g. after a download 401/redirect
// proves the cookies went stale before the TTL). Next getOrAcquire re-mints.
export function invalidate(provider: SessionProvider): void {
  sqlite.prepare("DELETE FROM provider_sessions WHERE provider = ?").run(provider);
}
