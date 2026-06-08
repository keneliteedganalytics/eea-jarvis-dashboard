// Equibase daily Premium PP auto-ingest.
//
// Replaces the manual step where Ken downloads PPs from equibase.com each
// morning. The flow (mapped in equibase_discovery_report.md — do NOT
// re-discover) is:
//   1. POST the ColdFusion login form -> CFID/CFTOKEN session cookies.
//   2. GET the Full PP page for a race date -> HTML listing each available
//      track as a download link carrying a server-generated `transid`.
//   3. GET each download link with the session cookies -> the PP PDF binary.
//   4. Parse the PDF with the existing Equibase parser and persist it.
//
// Credentials come ONLY from EQUIBASE_USERNAME / EQUIBASE_PASSWORD — never
// hardcoded. The whole module degrades gracefully (returns error statuses, logs
// telemetry) rather than throwing, because it runs unattended on a 6am cron.

import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { sqlite } from "../db";
import { parseEquibaseText, pdfToLayoutText } from "./parsers/equibase";
import type { EquibaseCard } from "./parsers/types";

const LOGIN_URL = "https://www.equibase.com/premium/eebCustomerLogon.cfm";
const PP_PAGE_URL = "https://www.equibase.com/premium/eqpEquibaseFullPP.cfm";
const DOWNLOAD_BASE = "https://www.equibase.com/premium/eebDownloadFPPProgram.cfm";
const PRODUCT_ID = "50300";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 EEA-Dashboard";

// ── Data dir ────────────────────────────────────────────────────────────────
// Mirror the AUDIO_DIR / showRoot convention: land on the Railway persistent
// volume when EQUIBASE_PP_DIR is set, else a sibling of the data dir, else an
// in-repo path for local dev.
export function ppRoot(): string {
  if (process.env.EQUIBASE_PP_DIR) return process.env.EQUIBASE_PP_DIR;
  const audioDir = process.env.AUDIO_DIR;
  if (audioDir) return path.join(path.dirname(audioDir), "equibase-pps");
  return path.join(process.cwd(), "server", "equibase-pps");
}

function ppDirForDate(raceDate: Date): string {
  return path.join(ppRoot(), ymd(raceDate));
}

// ── Track-selection config ────────────────────────────────────────────────
// A tiny JSON file (next to the PP store) recording which tracks to ingest each
// morning plus the last run's results. Engine/admin can override per call.
export interface IngestTrackResult {
  trackCode: string;
  status: "ok" | "skipped" | "error";
  error?: string;
  pdfPath?: string;
  byteCount?: number;
  httpStatus?: number;
  raceCount?: number;
}

export interface IngestConfig {
  enabledTrackCodes: string[];
  lastRun: string | null;
  lastResults: IngestTrackResult[];
}

const DEFAULT_CONFIG: IngestConfig = {
  // Finger Lakes today; Saratoga rolls in when its meet opens (mid-July).
  enabledTrackCodes: ["FL"],
  lastRun: null,
  lastResults: [],
};

function configPath(): string {
  return path.join(ppRoot(), "equibase-ingest.json");
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
  fs.mkdirSync(ppRoot(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

// ── Pure date helpers ───────────────────────────────────────────────────────
// All formatting is UTC-stable so a 6am-MDT cron can't drift the race date.
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// "MM/DD/YYYY" — the form/query format Equibase expects for raceDate.
export function formatRaceDateParam(d: Date): string {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

// "MMDD" — the zero-padded month+day embedded in the PP filename.
export function mmdd(d: Date): string {
  return `${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// "YYYYMMDD" — the on-disk folder name for a race date.
export function ymd(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// The PP filename: "{TRACK}{MMDD}FPP.PDF" (e.g. FL0608FPP.PDF).
export function ppFilename(trackCode: string, d: Date): string {
  return `${trackCode.toUpperCase()}${mmdd(d)}FPP.PDF`;
}

// Build the subscription download URL. `transid` is server-generated and must
// be scraped from the PP page — it cannot be invented — so it's a required arg.
export function buildDownloadUrl(
  trackCode: string,
  raceDate: Date,
  transid: string,
): string {
  const params = new URLSearchParams({
    transid,
    product_id: PRODUCT_ID,
    sequence: "1",
    filename: ppFilename(trackCode, raceDate),
  });
  return `${DOWNLOAD_BASE}?${params.toString()}`;
}

// ── Cookie jar (no external deps; native fetch only) ─────────────────────────
// ColdFusion auth is just CFID/CFTOKEN (+ JSESSIONID) carried as cookies. We
// keep a flat name->value map and re-serialize it on each request rather than
// pulling in tough-cookie/axios for a single host.
export type CookieJar = Map<string, string>;

export function parseSetCookies(headerValues: string[]): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of headerValues) {
    // Only the first "name=value" pair matters; attributes (Path, HttpOnly…)
    // follow the first ";" and are ignored for our single-host use.
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

// Node's fetch exposes multiple Set-Cookie values via Headers.getSetCookie().
function extractSetCookies(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

// ── HTML parsing ─────────────────────────────────────────────────────────────
export interface AvailableTrack {
  trackCode: string;
  trackName: string;
  transid: string;
  downloadUrl: string;
}

// Scrape every subscription download link off the Full PP page HTML. We key off
// the eebDownloadFPPProgram.cfm href and pull transid + filename out of it; the
// track code comes from the filename pattern ({TRACK}{MMDD}FPP.PDF), and the
// human track name from the link text / nearest label when present.
export function parseAvailableTracks(html: string): AvailableTrack[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: AvailableTrack[] = [];

  $("a[href*='eebDownloadFPPProgram.cfm']").each((_i, el) => {
    const href = $(el).attr("href") || "";
    // href may be relative, absolute, or protocol-relative — normalize.
    let url: URL;
    try {
      url = new URL(href, "https://www.equibase.com/premium/");
    } catch {
      return;
    }
    const transid = url.searchParams.get("transid") || "";
    const filename = url.searchParams.get("filename") || "";
    const m = filename.match(/^([A-Za-z]+)\d{4}FPP\.pdf$/i);
    if (!transid || !m) return;
    const trackCode = m[1].toUpperCase();
    if (seen.has(trackCode)) return;
    seen.add(trackCode);

    const linkText = $(el).text().trim();
    const trackName = linkText || trackCode;
    out.push({
      trackCode,
      trackName,
      transid,
      downloadUrl: url.toString(),
    });
  });

  return out;
}

// ── I/O: login / list / download ────────────────────────────────────────────
export async function loginEquibase(
  username: string,
  password: string,
): Promise<CookieJar> {
  const body = new URLSearchParams({
    username,
    password,
    // ColdFusion login forms commonly post these; harmless if ignored.
    login: "Login",
    rememberMe: "Y",
  });
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const jar = parseSetCookies(extractSetCookies(res.headers));
  if (!jar.has("CFID") && !jar.has("CFTOKEN") && !jar.has("JSESSIONID")) {
    throw new Error(
      `Equibase login did not set a session cookie (HTTP ${res.status})`,
    );
  }
  return jar;
}

export async function listAvailableTracks(
  jar: CookieJar,
  raceDate: Date,
): Promise<AvailableTrack[]> {
  const url = `${PP_PAGE_URL}?raceDate=${encodeURIComponent(
    formatRaceDateParam(raceDate),
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(jar) },
  });
  if (!res.ok) {
    throw new Error(`PP page HTTP ${res.status} for ${formatRaceDateParam(raceDate)}`);
  }
  const html = await res.text();
  return parseAvailableTracks(html);
}

// Download one PP PDF, persisting it to {ppRoot}/{YYYYMMDD}/{TRACK}.pdf.
export async function downloadPP(
  jar: CookieJar,
  track: AvailableTrack,
  raceDate: Date,
): Promise<{ pdfPath: string; byteCount: number; httpStatus: number }> {
  const res = await fetch(track.downloadUrl, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader(jar) },
  });
  const httpStatus = res.status;
  if (!res.ok) {
    throw new Error(`download HTTP ${httpStatus} for ${track.trackCode}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Guard against an HTML error/login page being served instead of a PDF.
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new Error(
      `download for ${track.trackCode} was not a PDF (${buf.length} bytes)`,
    );
  }
  const dir = ppDirForDate(raceDate);
  fs.mkdirSync(dir, { recursive: true });
  const pdfPath = path.join(dir, `${track.trackCode}.pdf`);
  fs.writeFileSync(pdfPath, buf);
  return { pdfPath, byteCount: buf.length, httpStatus };
}

export async function parsePP(
  pdfPath: string,
  trackCode: string,
  raceDate: Date,
): Promise<EquibaseCard> {
  const text = await pdfToLayoutText(pdfPath);
  // ISO date so the parsed card matches the shape the engine sees elsewhere.
  const iso = `${ymd(raceDate).slice(0, 4)}-${ymd(raceDate).slice(4, 6)}-${ymd(
    raceDate,
  ).slice(6, 8)}`;
  return parseEquibaseText(text, trackCode, iso);
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
        `INSERT INTO equibase_ingest_runs
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
    console.error("[equibase-ingest] failed to write telemetry:", e);
  }
}

// ── Top-level orchestration ──────────────────────────────────────────────────
export interface IngestResult {
  raceDate: string;
  status: "ok" | "partial" | "error";
  results: IngestTrackResult[];
  error?: string;
}

// Ingest tomorrow's (or any date's) PPs for the requested tracks. If
// `trackCodes` is omitted, falls back to the saved enabled tracks. Never throws
// — top-level failures (missing creds, login error) are captured as an error
// result + telemetry row so the cron stays alive.
export async function ingestForDate(
  raceDate: Date,
  trackCodes?: string[],
  trigger: "cron" | "manual" = "cron",
): Promise<IngestResult> {
  const startedAt = new Date().toISOString();
  const config = readConfig();
  const wanted = (trackCodes && trackCodes.length ? trackCodes : config.enabledTrackCodes).map(
    (c) => c.toUpperCase(),
  );
  const raceDateStr = formatRaceDateParam(raceDate);

  const username = process.env.EQUIBASE_USERNAME;
  const password = process.env.EQUIBASE_PASSWORD;
  if (!username || !password) {
    const error = "EQUIBASE_USERNAME / EQUIBASE_PASSWORD not set";
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
    const jar = await loginEquibase(username, password);
    const available = await listAvailableTracks(jar, raceDate);
    const byCode = new Map(available.map((t) => [t.trackCode, t]));

    for (const code of wanted) {
      const track = byCode.get(code);
      if (!track) {
        results.push({ trackCode: code, status: "skipped", error: "not listed for date" });
        continue;
      }
      try {
        const dl = await downloadPP(jar, track, raceDate);
        let raceCount: number | undefined;
        try {
          const card = await parsePP(dl.pdfPath, code, raceDate);
          raceCount = card.races.length;
        } catch (pe) {
          // A download that won't parse is still saved; record the parse error
          // but treat the track as ok (the PDF is on disk for manual recovery).
          console.error(`[equibase-ingest] parse failed for ${code}:`, pe);
        }
        results.push({
          trackCode: code,
          status: "ok",
          pdfPath: dl.pdfPath,
          byteCount: dl.byteCount,
          httpStatus: dl.httpStatus,
          raceCount,
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

  // Persist last-run state into the config so GET status is cheap.
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

// Convenience: the date of "tomorrow" in America/Boise wall-clock terms, used by
// the 6am cron. We add a day to the Boise-local calendar date, not UTC, so the
// cron always targets the correct racing day.
export function tomorrowInBoise(now: Date = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  // Construct in local time then advance one calendar day.
  const local = new Date(y, m - 1, d);
  local.setDate(local.getDate() + 1);
  return local;
}
