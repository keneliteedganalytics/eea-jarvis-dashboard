// Wet-track overlay — NWS forecast → inferred track condition (wet-track PR).
//
// This is a SEPARATE, lighter-weight signal from the OpenWeather race-weather
// service (server/services/weather.ts). That service derives a per-race
// surfaceImpact for the fusion engine; this one classifies a coarse
// `trackCondition` label for a CARD from the National Weather Service forecast,
// which is free, keyless, and the user's stated source of truth for FL.
//
// Classification (per spec):
//   PoP ≥ 50% AND rainfall ≥ 0.10" in next 6h  → "sloppy"
//   PoP ≥ 30% AND rainfall ≥ 0.05"             → "good"
//   else                                        → "fast"
//
// NEVER throws: any failure (network, bad payload, unknown grid) resolves to a
// null condition so the caller leaves picks untouched. Result cached 30 min.

import type { TrackCondition } from "@shared/schema";

const CACHE_TTL_MS = 30 * 60 * 1000;
// How far ahead we look for rain when inferring the strip (per spec: 6 hours).
const LOOKAHEAD_MS = 6 * 60 * 60 * 1000;
const MM_PER_INCH = 25.4;

// Known track coordinates. Finger Lakes (Farmington, NY) is the only track the
// overlay is enabled for right now (see spec §5 — cap to FL until tested).
export const TRACK_COORDS: Record<string, { lat: number; lon: number }> = {
  "Finger Lakes": { lat: 42.9856, lon: -77.3097 },
  FLX: { lat: 42.9856, lon: -77.3097 },
};

export function resolveTrackCoords(track: string): { lat: number; lon: number } | null {
  if (TRACK_COORDS[track]) return TRACK_COORDS[track];
  const upper = track.toUpperCase();
  for (const [k, v] of Object.entries(TRACK_COORDS)) {
    if (k.toUpperCase() === upper) return v;
  }
  return null;
}

// ── Pure classifier ─────────────────────────────────────────────────────────
// Given the peak PoP (%) and total rainfall (inches) over the lookahead window,
// return the inferred condition. Exported for unit testing.
export function classifyCondition(popPct: number, rainfallInches: number): TrackCondition {
  if (popPct >= 50 && rainfallInches >= 0.1) return "sloppy";
  if (popPct >= 30 && rainfallInches >= 0.05) return "good";
  return "fast";
}

// ── NWS gridpoint payload (only the fields we read) ──────────────────────────
interface NwsTimeValue {
  validTime: string; // ISO8601 interval, e.g. "2026-06-10T15:00:00+00:00/PT1H"
  value: number | null;
}
interface NwsGridProperties {
  probabilityOfPrecipitation?: { uom?: string; values?: NwsTimeValue[] };
  // QPF: liquid precip amount. NWS reports it in mm ("wmoUnit:mm").
  quantitativePrecipitation?: { uom?: string; values?: NwsTimeValue[] };
}
export interface NwsGridResponse {
  properties?: NwsGridProperties;
}

interface NwsPointResponse {
  properties?: { forecastGridData?: string };
}

// Parse an ISO8601 interval's start instant. NWS encodes "<start>/<duration>".
function intervalStartMs(validTime: string): number {
  const start = validTime.split("/")[0];
  const ms = new Date(start).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

// Reduce an NWS gridpoint payload into (peakPoP%, totalRainfallInches) over the
// lookahead window starting at `now`. Pure + exported for unit tests against a
// captured snapshot. A QPF value in mm is converted to inches.
export function summarizeNwsGrid(
  grid: NwsGridResponse,
  now: Date = new Date(),
  lookaheadMs: number = LOOKAHEAD_MS,
): { popPct: number; rainfallInches: number } {
  const startMs = now.getTime();
  const endMs = startMs + lookaheadMs;
  const props = grid.properties ?? {};

  const inWindow = (t: NwsTimeValue): boolean => {
    const ms = intervalStartMs(t.validTime);
    return !Number.isNaN(ms) && ms >= startMs - 60 * 60 * 1000 && ms <= endMs;
  };

  let popPct = 0;
  for (const v of props.probabilityOfPrecipitation?.values ?? []) {
    if (v.value != null && inWindow(v)) popPct = Math.max(popPct, v.value);
  }

  const qpfUom = props.quantitativePrecipitation?.uom ?? "";
  const qpfInMm = !/in/i.test(qpfUom); // default NWS unit is mm
  let rainfallAmt = 0;
  for (const v of props.quantitativePrecipitation?.values ?? []) {
    if (v.value != null && inWindow(v)) rainfallAmt += v.value;
  }
  const rainfallInches = qpfInMm ? rainfallAmt / MM_PER_INCH : rainfallAmt;

  return { popPct, rainfallInches: Math.round(rainfallInches * 1000) / 1000 };
}

export interface OverlayResult {
  condition: TrackCondition | null; // null when NWS was unreachable
  popPct: number | null;
  rainfallInches: number | null;
  fetchedAt: string;
  source: "nws";
}

function unknownOverlay(): OverlayResult {
  return { condition: null, popPct: null, rainfallInches: null, fetchedAt: new Date().toISOString(), source: "nws" };
}

interface CacheEntry {
  value: OverlayResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

export function clearOverlayCache(): void {
  cache.clear();
}

const NWS_HEADERS = {
  // NWS requires a User-Agent identifying the app/contact.
  "User-Agent": "EEA-Jarvis-Dashboard (ken@elite-edge-analytics.com)",
  Accept: "application/geo+json",
};

// Fetch + classify the track condition for a track. Resolves to a null-condition
// OverlayResult on any failure. Cached 30 min per (lat,lon, hour bucket of now).
export async function inferTrackCondition(
  track: string,
  now: Date = new Date(),
): Promise<OverlayResult> {
  const coords = resolveTrackCoords(track);
  if (!coords) return unknownOverlay();

  const bucket = Math.floor(now.getTime() / CACHE_TTL_MS);
  const cacheKey = `${coords.lat},${coords.lon}|${bucket}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const pointUrl = `https://api.weather.gov/points/${coords.lat},${coords.lon}`;
    const pointRes = await fetch(pointUrl, { headers: NWS_HEADERS });
    if (!pointRes.ok) return unknownOverlay();
    const point = (await pointRes.json()) as NwsPointResponse;
    const gridUrl = point.properties?.forecastGridData;
    if (!gridUrl) return unknownOverlay();

    const gridRes = await fetch(gridUrl, { headers: NWS_HEADERS });
    if (!gridRes.ok) return unknownOverlay();
    const grid = (await gridRes.json()) as NwsGridResponse;

    const { popPct, rainfallInches } = summarizeNwsGrid(grid, now);
    const result: OverlayResult = {
      condition: classifyCondition(popPct, rainfallInches),
      popPct,
      rainfallInches,
      fetchedAt: new Date().toISOString(),
      source: "nws",
    };
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    return unknownOverlay();
  }
}

// Map a coarse trackCondition to the fusion engine's SurfaceImpact so the picker
// re-weighting and existing weather block agree on what "wet dirt" means.
export function conditionToSurfaceImpact(
  c: TrackCondition | null,
): "dry" | "wet" | "sloppy" | "muddy" | "unknown" {
  switch (c) {
    case "sloppy":
      return "sloppy";
    case "muddy":
      return "muddy";
    case "wet-fast":
      return "wet";
    case "fast":
    case "good":
      return "dry";
    default:
      return "unknown";
  }
}
