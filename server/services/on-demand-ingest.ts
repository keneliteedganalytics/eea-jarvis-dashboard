// On-demand track+date ingest.
//
// Lets the user pull any track+date ad hoc ("pull Finger Lakes for June 9")
// instead of waiting for the 6am cron. It mirrors the cron's sequence —
// Equibase first, then Brisnet — but is driven by an explicit track+date and
// finishes by running the same analyze-card pipeline the rest of the app uses,
// landing a DRAFT card (locked = false) for the user to review and publish.
//
// The card is NEVER published here. The two-source contract matches the cron:
//   - Equibase ingest downloads the PP PDF to disk and returns its path.
//   - Brisnet ingest downloads the DRM zip, persists per-horse rows to
//     brisnet_horse_data, and returns the zip path. analyze-card reads that
//     DRM data back via getBloodstockForCard() for the bloodstock factor.
// If Brisnet fails the Equibase-only draft still persists, marked "partial".

import { storage } from "../storage";
import {
  ingestForDate as equibaseIngestForDate,
  ppRoot,
  ppFilename,
  ymd,
  type IngestResult as EquibaseIngestResult,
} from "./equibase-ingest";
import {
  ingestForDate as brisnetIngestForDate,
  type IngestResult as BrisnetIngestResult,
} from "./brisnet-ingest";
import { analyzeCard } from "./analyze-card";
import { broadcastEvent } from "./events";
import path from "node:path";
import fs from "node:fs";

export interface OnDemandIngestRequest {
  track: string; // human track name, fuzzy-resolved (e.g. "finger lake" -> "Finger Lakes")
  date: string; // ISO YYYY-MM-DD
  source?: "both" | "equibase" | "brisnet"; // default "both"
}

export interface OnDemandIngestResult {
  status: "success" | "partial" | "failed";
  cardId?: number;
  track: string;
  date: string;
  raceCount?: number;
  conviction?: string;
  sources: {
    equibase: { ok: boolean; raceCount?: number; error?: string };
    brisnet: { ok: boolean; raceCount?: number; error?: string };
  };
  warnings: string[];
  durationMs: number;
}

// Per-source and whole-job timeouts (spec: 90s per source, 300s total).
const PER_SOURCE_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 300_000;

// ── Canonical track table ────────────────────────────────────────────────────
// name → { code, aliases }. Codes are the 2–3 letter Equibase/Brisnet track
// codes the ingest functions expect. Aliases cover common speech mishears and
// shorthand. Keep the spec's minimum set; extend as meets open.
interface CanonTrack {
  name: string;
  code: string;
  aliases: string[];
}

const CANONICAL_TRACKS: CanonTrack[] = [
  { name: "Finger Lakes", code: "FL", aliases: ["finger lake", "fingerlakes", "fingerlake", "fl"] },
  { name: "Saratoga", code: "SAR", aliases: ["saratoga springs", "the spa", "sar"] },
  { name: "Belmont", code: "BEL", aliases: ["belmont park", "belmont at the big a", "bel"] },
  { name: "Churchill", code: "CD", aliases: ["churchill downs", "cd"] },
  { name: "Gulfstream", code: "GP", aliases: ["gulfstream park", "gp"] },
  { name: "Tampa Bay Downs", code: "TAM", aliases: ["tampa", "tampa bay", "tampa downs", "tam"] },
  { name: "Oaklawn", code: "OP", aliases: ["oaklawn park", "op"] },
  { name: "Aqueduct", code: "AQU", aliases: ["the big a", "aqu"] },
  { name: "Keeneland", code: "KEE", aliases: ["kee"] },
  { name: "Del Mar", code: "DMR", aliases: ["delmar", "dmr"] },
  { name: "Santa Anita", code: "SA", aliases: ["santa anita park", "the great race place", "sa"] },
  { name: "Pimlico", code: "PIM", aliases: ["old hilltop", "pim"] },
  { name: "Monmouth", code: "MTH", aliases: ["monmouth park", "mth"] },
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// Resolve a spoken/typed track name to its canonical entry. Exact name, alias,
// then a loose contains/levenshtein-ish match. Returns null if nothing resolves.
export function resolveTrack(input: string): CanonTrack | null {
  const q = normalize(input);
  if (!q) return null;
  for (const t of CANONICAL_TRACKS) {
    if (normalize(t.name) === q) return t;
    if (t.aliases.some((a) => normalize(a) === q)) return t;
    if (t.code.toLowerCase() === q) return t;
  }
  // Loose: query is a prefix/substring of the canonical name or vice versa.
  for (const t of CANONICAL_TRACKS) {
    const n = normalize(t.name);
    if (n.startsWith(q) || q.startsWith(n) || n.includes(q) || q.includes(n)) return t;
  }
  return null;
}

// Validate an ISO YYYY-MM-DD date within [-365, +30] days of today. Returns a
// Date (UTC-noon to avoid TZ edge flips) or an error string.
export function validateDate(date: string): { date: Date } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `Date must be YYYY-MM-DD, got "${date}".` };
  }
  const [y, m, d] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return { error: `"${date}" is not a real calendar date.` };
  }
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const dayMs = 86_400_000;
  const deltaDays = Math.round((parsed.getTime() - today.getTime()) / dayMs);
  if (deltaDays > 30) return { error: `Date is more than 30 days out (${date}).` };
  if (deltaDays < -365) return { error: `Date is more than 365 days in the past (${date}).` };
  return { date: parsed };
}

// Wrap a promise in a timeout that rejects with a labeled error.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Run one ingest source with a single retry on failure (spec: rate-limit / 503
// → retry once with backoff, then fail that source gracefully). The underlying
// ingestForDate never throws, so a thrown error here is a timeout or a hard
// transport failure; both are retried once.
async function runSourceWithRetry(
  fn: () => Promise<EquibaseIngestResult | BrisnetIngestResult>,
  label: string,
): Promise<EquibaseIngestResult | BrisnetIngestResult> {
  try {
    return await withTimeout(fn(), PER_SOURCE_TIMEOUT_MS, label);
  } catch {
    // Single retry with a short backoff (rate-limit / 503 / timeout).
    await new Promise((r) => setTimeout(r, 1500));
    return await withTimeout(fn(), PER_SOURCE_TIMEOUT_MS, label);
  }
}

// Pull the per-track raceCount + (Equibase) PDF path out of an IngestResult.
function trackResult(
  res: EquibaseIngestResult | BrisnetIngestResult | null,
  code: string,
): { ok: boolean; raceCount?: number; pdfPath?: string; zipPath?: string; error?: string } {
  if (!res) return { ok: false, error: "source not run" };
  const r = res.results.find((x) => x.trackCode.toUpperCase() === code.toUpperCase());
  if (!r) {
    return { ok: false, error: res.error ?? `${code} not listed for date` };
  }
  if (r.status === "ok") {
    return {
      ok: true,
      raceCount: r.raceCount,
      pdfPath: (r as { pdfPath?: string }).pdfPath,
      zipPath: (r as { zipPath?: string }).zipPath,
    };
  }
  return { ok: false, error: r.error ?? `${code} ${r.status}` };
}

// Locate the Equibase PP PDF on disk for (track, date). Prefer the path the
// ingest reported; fall back to the deterministic on-disk convention.
function equibasePdfPath(reported: string | undefined, code: string, raceDate: Date): string | null {
  if (reported && fs.existsSync(reported)) return reported;
  const guess = path.join(ppRoot(), ymd(raceDate), ppFilename(code, raceDate));
  return fs.existsSync(guess) ? guess : null;
}

export interface OnDemandIngestDeps {
  runEquibase?: (raceDate: Date, codes: string[]) => Promise<EquibaseIngestResult>;
  runBrisnet?: (raceDate: Date, codes: string[]) => Promise<BrisnetIngestResult>;
  analyze?: typeof analyzeCard;
}

export async function runOnDemandIngest(
  req: OnDemandIngestRequest,
  deps: OnDemandIngestDeps = {},
): Promise<OnDemandIngestResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const source = req.source ?? "both";

  const runEquibase = deps.runEquibase ?? ((d, c) => equibaseIngestForDate(d, c, "manual"));
  const runBrisnet = deps.runBrisnet ?? ((d, c) => brisnetIngestForDate(d, c, "manual"));
  const analyze = deps.analyze ?? analyzeCard;

  // Resolve track + date up front so we fail fast with a clear message.
  const canon = resolveTrack(req.track);
  if (!canon) {
    return {
      status: "failed",
      track: req.track,
      date: req.date,
      sources: { equibase: { ok: false }, brisnet: { ok: false } },
      warnings: [`Unknown track "${req.track}". Say a track like Finger Lakes or Saratoga.`],
      durationMs: Date.now() - started,
    };
  }
  const dateCheck = validateDate(req.date);
  if ("error" in dateCheck) {
    return {
      status: "failed",
      track: canon.name,
      date: req.date,
      sources: { equibase: { ok: false }, brisnet: { ok: false } },
      warnings: [dateCheck.error],
      durationMs: Date.now() - started,
    };
  }
  const raceDate = dateCheck.date;

  // Duplicate check: a card already exists for (canonical track, date).
  const existing = storage
    .getCards()
    .find((c) => c.track === canon.name && c.date === req.date);
  if (existing) {
    return {
      status: "success",
      cardId: existing.id,
      track: canon.name,
      date: req.date,
      conviction: existing.cardConviction ?? undefined,
      raceCount: storage.getCardWithRaces(existing.id)?.races.length,
      sources: { equibase: { ok: true }, brisnet: { ok: true } },
      warnings: ["existing card returned, ingest skipped"],
      durationMs: Date.now() - started,
    };
  }

  broadcastEvent("on-demand-ingest:started", { track: canon.name, date: req.date });

  const sources: OnDemandIngestResult["sources"] = {
    equibase: { ok: false },
    brisnet: { ok: false },
  };

  // Build + broadcast a failed result from inside the pipeline (all carry the
  // running `sources` and emit the :completed event).
  const fail = (msgs: string[]): OnDemandIngestResult => {
    const result: OnDemandIngestResult = {
      status: "failed",
      track: canon.name,
      date: req.date,
      sources,
      warnings: msgs,
      durationMs: Date.now() - started,
    };
    broadcastEvent("on-demand-ingest:completed", { result });
    return result;
  };

  return await withTimeout(
    (async (): Promise<OnDemandIngestResult> => {
      // ── Equibase first (matches the cron) ────────────────────────────────
      let equiRes: EquibaseIngestResult | null = null;
      if (source === "both" || source === "equibase") {
        broadcastEvent("on-demand-ingest:source-progress", { source: "equibase", status: "running" });
        try {
          equiRes = (await runSourceWithRetry(
            () => runEquibase(raceDate, [canon.code]),
            "equibase",
          )) as EquibaseIngestResult;
        } catch (e) {
          equiRes = null;
          warnings.push(`Equibase failed: ${(e as Error).message}`);
        }
        const er = trackResult(equiRes, canon.code);
        sources.equibase = { ok: er.ok, raceCount: er.raceCount, error: er.error };
        broadcastEvent("on-demand-ingest:source-progress", {
          source: "equibase",
          status: er.ok ? "ok" : "error",
        });
      }

      // ── Brisnet second ───────────────────────────────────────────────────
      let brisRes: BrisnetIngestResult | null = null;
      if (source === "both" || source === "brisnet") {
        broadcastEvent("on-demand-ingest:source-progress", { source: "brisnet", status: "running" });
        try {
          brisRes = (await runSourceWithRetry(
            () => runBrisnet(raceDate, [canon.code]),
            "brisnet",
          )) as BrisnetIngestResult;
        } catch (e) {
          brisRes = null;
          warnings.push(`Brisnet failed: ${(e as Error).message}`);
        }
        const br = trackResult(brisRes, canon.code);
        sources.brisnet = { ok: br.ok, raceCount: br.raceCount, error: br.error };
        if (!br.ok && br.error) warnings.push(`Brisnet: ${br.error}`);
        broadcastEvent("on-demand-ingest:source-progress", {
          source: "brisnet",
          status: br.ok ? "ok" : "error",
        });
      }

      const er = trackResult(equiRes, canon.code);
      const br = trackResult(brisRes, canon.code);

      // Need at least one usable source to build a card.
      if (!er.ok && !br.ok) {
        return fail(warnings.length ? warnings : [`No races found for ${canon.name} on ${req.date}`]);
      }

      // Empty PPs (track dark): source returned ok with zero races.
      const equiRaces = er.ok ? er.raceCount ?? 0 : 0;
      const brisRaces = br.ok ? br.raceCount ?? 0 : 0;
      if (equiRaces === 0 && brisRaces === 0) {
        return fail([`No races found for ${canon.name} on ${req.date}`]);
      }

      // Resolve the PDF paths analyze-card parses. Equibase is the speed-figure
      // source; Brisnet DRM lands in the DB (read by getBloodstockForCard), so
      // when only the zip exists we hand analyze-card the Equibase PDF for both
      // and let the DB-side DRM join supply bloodstock.
      const equiPath = equibasePdfPath(er.pdfPath, canon.code, raceDate);
      if (!equiPath) {
        return fail([
          ...warnings,
          `Equibase PP file for ${canon.name} on ${req.date} was not found on disk.`,
        ]);
      }
      const brisPath = br.zipPath && fs.existsSync(br.zipPath) ? br.zipPath : equiPath;

      const analysis = await analyze({
        track: canon.name,
        date: req.date,
        equibasePath: equiPath,
        brisnetPath: brisPath,
        equibaseFilename: path.basename(equiPath),
        brisnetFilename: path.basename(brisPath),
      });
      for (const e of analysis.errors) warnings.push(e);

      const card = storage.getCard(analysis.cardId);
      const isPartial = !br.ok || br.error != null;
      if (isPartial && card) {
        const note = `On-demand ingest: Brisnet unavailable (${br.error ?? "unknown"}). Equibase-only draft.`;
        storage.updateCard(analysis.cardId, {
          notes: card.notes ? `${card.notes}\n${note}` : note,
        });
        warnings.push("Brisnet failed; persisted Equibase-only partial draft.");
      }

      const result: OnDemandIngestResult = {
        status: isPartial ? "partial" : "success",
        cardId: analysis.cardId,
        track: canon.name,
        date: req.date,
        raceCount: storage.getCardWithRaces(analysis.cardId)?.races.length,
        conviction: card?.cardConviction ?? undefined,
        sources,
        warnings,
        durationMs: Date.now() - started,
      };
      broadcastEvent("on-demand-ingest:completed", { result });
      return result;
    })(),
    TOTAL_TIMEOUT_MS,
    "on-demand-ingest",
  ).catch((e) => fail([...warnings, (e as Error).message]));
}
