// Brisnet DRM (PP Data Files multi) daily auto-ingest.
//
// Parallel to equibase-ingest.ts (PR #14): downloads the Brisnet DRM zip for
// each enabled track every morning, extracts the .DR2 file, parses the
// high-value BRIS fields (Prime Power, run style / race shape, speed+pace pars,
// best speed by surface, company line) and persists them to brisnet_horse_data
// keyed by (race_date, track_code, race_number, program_number) for the engine
// to join with the Equibase PP card.
//
// The flow (mapped in brisnet_multifile_discovery_report.md — do NOT
// re-discover) is:
//   1. POST username/password to /product/login -> session cookie (PHP/Symfony).
//   2. GET the per-track download URL with the cookie -> a binary zip.
//   3. Reject text/html responses (session expired or no card) and re-auth once.
//   4. Extract + parse the .DR2 and store rows.
//
// Credentials come ONLY from BRISNET_USERNAME / BRISNET_PASSWORD. The module
// degrades gracefully (error statuses + telemetry) rather than throwing, because
// it runs unattended on a 6am cron right after the Equibase ingest.

import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../db";
import { parseDrmZip, type DrmCard } from "./parsers/brisnet-drm";

const LOGIN_URL = "https://www.brisnet.com/product/login";
const DOWNLOAD_BASE = "https://www.brisnet.com/product/download";
// URL segments observed for US thoroughbred multi-file PP downloads.
const PRODUCT_CODE = "DRM";
const COUNTRY = "USA";
const RACE_TYPE = "TB";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function debug(...args: unknown[]): void {
  if (process.env.BRISNET_DEBUG === "1") console.log("[brisnet-debug]", ...args);
}

// ── Storage dir (mirrors equibase ppRoot) ────────────────────────────────────
export function drmRoot(): string {
  if (process.env.BRISNET_DRM_DIR) return process.env.BRISNET_DRM_DIR;
  const audioDir = process.env.AUDIO_DIR;
  if (audioDir) return path.join(path.dirname(audioDir), "brisnet-drm");
  return path.join(process.cwd(), "server", "brisnet-drm");
}

function drmDirForDate(raceDate: Date): string {
  return path.join(drmRoot(), ymd(raceDate));
}

// ── Track-selection config ────────────────────────────────────────────────
export interface IngestTrackResult {
  trackCode: string;
  status: "ok" | "skipped" | "error";
  error?: string;
  zipPath?: string;
  byteCount?: number;
  httpStatus?: number;
  raceCount?: number;
  horseCount?: number;
}

export interface IngestConfig {
  enabledTrackCodes: string[];
  lastRun: string | null;
  lastResults: IngestTrackResult[];
}

const DEFAULT_CONFIG: IngestConfig = {
  // Finger Lakes today; matches the Equibase ingest's enabled set.
  enabledTrackCodes: ["FL"],
  lastRun: null,
  lastResults: [],
};

function configPath(): string {
  return path.join(drmRoot(), "brisnet-ingest.json");
}

export function readConfig(): IngestConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<IngestConfig>;
    return {
      enabledTrackCodes: Array.isArray(parsed.enabledTrackCodes)
        ? parsed.enabledTrackCodes
        : DEFAULT_CONFIG.enabledTrackCodes,
      lastRun: parsed.lastRun ?? null,
      lastResults: Array.isArray(parsed.lastResults) ? parsed.lastResults : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(cfg: IngestConfig): void {
  fs.mkdirSync(drmRoot(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

// ── Pure date helpers (UTC-stable) ────────────────────────────────────────
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "YYYY-MM-DD" — the date segment the Brisnet download URL expects.
export function formatRaceDateParam(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "YYYYMMDD" — on-disk folder name for a race date.
export function ymd(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// Build the DRM download URL:
//   /product/download/{YYYY-MM-DD}/DRM/USA/TB/{TRACK}/D/0/
export function buildDownloadUrl(trackCode: string, raceDate: Date): string {
  const segs = [
    DOWNLOAD_BASE,
    formatRaceDateParam(raceDate),
    PRODUCT_CODE,
    COUNTRY,
    RACE_TYPE,
    trackCode.toUpperCase(),
    "D",
    "0",
  ];
  // Trailing slash matches the observed pattern.
  return `${segs.join("/")}/`;
}

// ── Cookie jar (native fetch only; mirrors equibase-ingest) ──────────────────
export type CookieJar = Map<string, string>;

export function parseSetCookies(headerValues: string[]): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of headerValues) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
  return jar;
}

function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeSetCookies(jar: CookieJar, headers: Headers): string[] {
  const lines = extractSetCookies(headers);
  for (const [k, v] of Array.from(parseSetCookies(lines).entries())) jar.set(k, v);
  return lines;
}

const MAX_LOGIN_HOPS = 5;

// Has the jar captured something that looks like a session cookie? Brisnet uses
// PHP/Symfony session infrastructure, so accept PHPSESSID or any *SESS* cookie.
export function hasSessionCookie(jar: CookieJar): boolean {
  for (const name of Array.from(jar.keys())) {
    if (/sess/i.test(name)) return true;
  }
  return false;
}

// Log in and capture the session cookie across any redirect hops. Same hardening
// as the Equibase login fix (PR #14b): manual redirect following, cookies folded
// from every hop, a real Chrome UA (login pages routinely gate cookies on UA).
export async function loginBrisnet(
  username: string,
  password: string,
): Promise<CookieJar> {
  const body = new URLSearchParams({ username, password });
  const jar: CookieJar = new Map();

  let res = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  let setLines = mergeSetCookies(jar, res.headers);
  debug("login POST", LOGIN_URL, "->", res.status, {
    location: res.headers.get("location"),
    setCookies: parseSetCookies(setLines).size,
    jar: Array.from(jar.keys()),
  });

  let url = LOGIN_URL;
  for (let hop = 0; hop < MAX_LOGIN_HOPS; hop++) {
    const status = res.status;
    const location = res.headers.get("location");
    if (status < 300 || status >= 400 || !location) break;
    url = new URL(location, url).toString();
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(jar) },
    });
    setLines = mergeSetCookies(jar, res.headers);
    debug(`login hop ${hop + 1}`, url, "->", res.status, {
      location: res.headers.get("location"),
      setCookies: parseSetCookies(setLines).size,
      jar: Array.from(jar.keys()),
    });
  }

  if (!hasSessionCookie(jar)) {
    throw new Error(
      `Brisnet login did not set a session cookie (HTTP ${res.status}; ` +
        `set BRISNET_DEBUG=1 to dump the redirect chain)`,
    );
  }
  return jar;
}

// ── Download ─────────────────────────────────────────────────────────────────
// Returns the zip bytes for a track/date, or throws on HTTP error / a non-zip
// (HTML login or "no card") response. We don't follow redirects here: a 3xx to
// /product/login means the session expired and the caller should re-auth.
export async function downloadDrmZip(
  jar: CookieJar,
  trackCode: string,
  raceDate: Date,
): Promise<{ buf: Buffer; httpStatus: number; contentType: string }> {
  const url = buildDownloadUrl(trackCode, raceDate);
  const res = await fetch(url, {
    redirect: "manual",
    headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(jar) },
  });
  const httpStatus = res.status;
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  debug("download", url, "->", httpStatus, contentType);

  if (httpStatus >= 300 && httpStatus < 400) {
    throw new Error(
      `download for ${trackCode} redirected (HTTP ${httpStatus}) — session likely expired`,
    );
  }
  if (!res.ok) {
    throw new Error(`download HTTP ${httpStatus} for ${trackCode}`);
  }
  if (contentType.includes("text/html")) {
    throw new Error(
      `download for ${trackCode} returned HTML (session expired or no card)`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Zip local-file-header magic "PK\x03\x04". Guards against an HTML/error page
  // served with a non-html content-type.
  if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
    throw new Error(
      `download for ${trackCode} was not a zip (${buf.length} bytes, ${contentType})`,
    );
  }
  return { buf, httpStatus, contentType };
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Upsert every parsed horse row for a card into brisnet_horse_data. Returns the
// number of rows written. Uses the unique key so a re-run replaces cleanly.
export function persistCard(card: DrmCard, raceDate: Date): number {
  const isoDate = formatRaceDateParam(raceDate);
  const trackCode = card.trackCode.trim().toUpperCase();
  const ingestedAt = new Date().toISOString();
  const stmt = sqlite.prepare(
    `INSERT INTO brisnet_horse_data
       (race_date, track_code, race_number, program_number, run_style,
        prime_power, best_speed, best_speed_surf_a, best_speed_surf_b,
        speed_par_early, speed_par_late, pace_par_e1, pace_par_e2,
        ml_odds, company_line, raw_row, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (race_date, track_code, race_number, program_number)
     DO UPDATE SET
       run_style=excluded.run_style,
       prime_power=excluded.prime_power,
       best_speed=excluded.best_speed,
       best_speed_surf_a=excluded.best_speed_surf_a,
       best_speed_surf_b=excluded.best_speed_surf_b,
       speed_par_early=excluded.speed_par_early,
       speed_par_late=excluded.speed_par_late,
       pace_par_e1=excluded.pace_par_e1,
       pace_par_e2=excluded.pace_par_e2,
       ml_odds=excluded.ml_odds,
       company_line=excluded.company_line,
       raw_row=excluded.raw_row,
       ingested_at=excluded.ingested_at`,
  );
  let count = 0;
  const tx = sqlite.transaction(() => {
    for (const race of card.races) {
      for (const h of race.horses) {
        stmt.run(
          isoDate,
          trackCode,
          race.raceNumber,
          h.programNumber,
          h.runStyle,
          h.primePower,
          h.bestSpeed,
          h.bestSpeedBySurface.a,
          h.bestSpeedBySurface.b,
          race.speedParEarly,
          race.speedParLate,
          race.paceParE1,
          race.paceParE2,
          h.mlOdds,
          h.companyLine,
          JSON.stringify(h.rawRow),
          ingestedAt,
        );
        count++;
      }
    }
  });
  tx();
  return count;
}

// ── Telemetry ────────────────────────────────────────────────────────────────
function logRun(row: {
  raceDate: string;
  trackCodes: string[];
  trigger: string;
  status: string;
  results: IngestTrackResult[];
  error?: string;
  startedAt: string;
  completedAt: string;
}): void {
  try {
    sqlite
      .prepare(
        `INSERT INTO brisnet_ingest_runs
           (race_date, track_codes, trigger, status, results_json, error, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.raceDate,
        JSON.stringify(row.trackCodes),
        row.trigger,
        row.status,
        JSON.stringify(row.results),
        row.error ?? null,
        row.startedAt,
        row.completedAt,
      );
  } catch (e) {
    console.error("[brisnet-ingest] failed to write telemetry:", e);
  }
}

// ── Top-level orchestration ──────────────────────────────────────────────────
export interface IngestResult {
  raceDate: string;
  status: "ok" | "partial" | "error";
  results: IngestTrackResult[];
  error?: string;
}

export async function ingestForDate(
  raceDate: Date,
  trackCodes?: string[],
  trigger: "cron" | "manual" = "cron",
): Promise<IngestResult> {
  const startedAt = new Date().toISOString();
  const config = readConfig();
  const wanted = (
    trackCodes && trackCodes.length ? trackCodes : config.enabledTrackCodes
  ).map((c) => c.toUpperCase());
  const raceDateStr = formatRaceDateParam(raceDate);

  const username = process.env.BRISNET_USERNAME;
  const password = process.env.BRISNET_PASSWORD;
  if (!username || !password) {
    const error = "BRISNET_USERNAME / BRISNET_PASSWORD not set";
    const completedAt = new Date().toISOString();
    logRun({
      raceDate: raceDateStr,
      trackCodes: wanted,
      trigger,
      status: "error",
      results: [],
      error,
      startedAt,
      completedAt,
    });
    return { raceDate: raceDateStr, status: "error", results: [], error };
  }

  const results: IngestTrackResult[] = [];
  let topError: string | undefined;

  try {
    const jar = await loginBrisnet(username, password);

    for (const code of wanted) {
      try {
        const dl = await downloadDrmZip(jar, code, raceDate);
        // Persist the raw zip for manual recovery / re-parse.
        const dir = drmDirForDate(raceDate);
        fs.mkdirSync(dir, { recursive: true });
        const zipPath = path.join(dir, `${code}.zip`);
        fs.writeFileSync(zipPath, dl.buf);

        let raceCount: number | undefined;
        let horseCount: number | undefined;
        try {
          const card = parseDrmZip(dl.buf, code);
          raceCount = card.races.length;
          horseCount = persistCard(card, raceDate);
        } catch (pe) {
          // A zip that won't parse is still saved; record the parse error but
          // keep the track ok (the zip is on disk for manual recovery).
          console.error(`[brisnet-ingest] parse failed for ${code}:`, pe);
        }

        results.push({
          trackCode: code,
          status: "ok",
          zipPath,
          byteCount: dl.buf.length,
          httpStatus: dl.httpStatus,
          raceCount,
          horseCount,
        });
      } catch (de) {
        results.push({
          trackCode: code,
          status: "error",
          error: (de as Error).message,
        });
      }
    }
  } catch (e) {
    topError = (e as Error).message;
  }

  const completedAt = new Date().toISOString();
  const anyOk = results.some((r) => r.status === "ok");
  const anyError = topError != null || results.some((r) => r.status === "error");
  const status: IngestResult["status"] = topError
    ? "error"
    : anyOk && anyError
      ? "partial"
      : anyError && !anyOk
        ? "error"
        : "ok";

  writeConfig({
    enabledTrackCodes: config.enabledTrackCodes,
    lastRun: completedAt,
    lastResults: results,
  });

  logRun({
    raceDate: raceDateStr,
    trackCodes: wanted,
    trigger,
    status,
    results,
    error: topError,
    startedAt,
    completedAt,
  });

  return { raceDate: raceDateStr, status, results, error: topError };
}

// "Tomorrow" in America/Boise wall-clock terms (same as equibase-ingest), used
// by the 6am cron so it always targets the correct racing day.
export function tomorrowInBoise(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  const local = new Date(y, m - 1, d);
  local.setDate(local.getDate() + 1);
  return local;
}
