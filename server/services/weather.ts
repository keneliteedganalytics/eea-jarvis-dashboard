// OpenWeather (One Call 3.0) → per-race forecast → handicapping signal (PR #18).
//
// getRaceWeather(trackCode|trackName, postTimeUtc) returns a typed RaceWeather.
// It NEVER throws: any failure (unknown track, missing key, network error, bad
// payload) resolves to a "unknown" forecast so the caller — and the engine —
// can degrade gracefully and leave picks untouched.
//
// Two cache layers:
//   1. In-memory, keyed by (trackKey, hour-bucket-UTC), 30-min TTL. Cheap dedupe
//      for the scheduler hitting the same hour repeatedly.
//   2. Persistent race_weather row (written by the caller via storage) for
//      backtesting. This module only owns the fetch + derivation.

import fs from "node:fs";
import path from "node:path";
import type { RaceWeather, SurfaceImpact } from "@shared/schema";

const API_KEY = process.env.OPENWEATHER_API_KEY || "38631fb1a4eacae7660b83c2d7a337ac";
const ONE_CALL_URL = "https://api.openweathermap.org/data/3.0/onecall";

// Beyond this horizon the One Call hourly array (48h) no longer covers the post
// time, so we fall back to the daily forecast bucket.
const HOURLY_HORIZON_MS = 48 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;

// ── Precip → surface thresholds (documented; see PR description) ─────────────
// OpenWeather reports precip as mm of accumulation. We combine the post-hour
// forecast with the prior-6-hour accumulation, because a track that has been
// rained on for hours plays far wetter than one catching its first drops.
//   priorAccum (mm over the 6h before post) drives the standing-water tiers;
//   hourly precip at post nudges between adjacent tiers.
//
//   total = priorAccum + hourlyAtPost
//   total <  0.2  -> dry     (trace / none)
//   total <  2.5  -> damp     (light rain, surface tightening but fast)
//   total <  7.0  -> wet      (sealed/wet-fast, meaningful moisture)
//   total < 15.0  -> sloppy   (standing water, surface compromised)
//   total >= 15.0 -> muddy    (saturated/off the turf)
export const SURFACE_THRESHOLDS = {
  damp: 0.2,
  wet: 2.5,
  sloppy: 7.0,
  muddy: 15.0,
} as const;

export function deriveSurfaceImpact(hourlyPrecipMm: number, priorAccumMm: number): SurfaceImpact {
  const total = Math.max(0, hourlyPrecipMm) + Math.max(0, priorAccumMm);
  if (total < SURFACE_THRESHOLDS.damp) return "dry";
  if (total < SURFACE_THRESHOLDS.wet) return "damp";
  if (total < SURFACE_THRESHOLDS.sloppy) return "wet";
  if (total < SURFACE_THRESHOLDS.muddy) return "sloppy";
  return "muddy";
}

// ── Track → lat/lon ─────────────────────────────────────────────────────────
export interface TrackLocation {
  name: string;
  lat: number;
  lon: number;
  tz?: string;
}

let locationsCache: Record<string, TrackLocation> | null = null;

function loadLocations(): Record<string, TrackLocation> {
  if (locationsCache) return locationsCache;
  const candidates = [
    path.join(process.cwd(), "server", "data", "track_locations.json"),
    path.join(process.cwd(), "dist", "data", "track_locations.json"),
    path.join(process.cwd(), "data", "track_locations.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, TrackLocation> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith("_")) continue;
        const loc = v as Partial<TrackLocation>;
        if (typeof loc?.lat === "number" && typeof loc?.lon === "number") {
          out[k] = { name: loc.name ?? k, lat: loc.lat, lon: loc.lon, tz: loc.tz };
        }
      }
      locationsCache = out;
      return out;
    } catch {
      /* try next candidate */
    }
  }
  locationsCache = {};
  return locationsCache;
}

// Resolve a track code OR full name to coordinates. Case-insensitive on the key.
export function resolveTrackLocation(track: string): TrackLocation | null {
  const locs = loadLocations();
  if (locs[track]) return locs[track];
  const upper = track.toUpperCase();
  for (const [k, v] of Object.entries(locs)) {
    if (k.toUpperCase() === upper) return v;
  }
  return null;
}

// ── The "unknown" sentinel — returned on every failure path ─────────────────
function unknownWeather(): RaceWeather {
  return {
    tempF: null,
    feelsLikeF: null,
    conditions: null,
    precipMm: null,
    windMph: null,
    windDirDeg: null,
    humidityPct: null,
    surfaceImpact: "unknown",
    fetchedAt: new Date().toISOString(),
    source: "openweather",
  };
}

// ── In-memory cache ──────────────────────────────────────────────────────────
interface CacheEntry {
  value: RaceWeather;
  expiresAt: number;
}
const memCache = new Map<string, CacheEntry>();

// Round a post time down to its UTC hour so all races in the same hour at a
// track share one forecast bucket.
export function hourBucketUtc(postTimeUtc: string): string {
  const d = new Date(postTimeUtc);
  if (Number.isNaN(d.getTime())) return postTimeUtc;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function clearWeatherCache(): void {
  memCache.clear();
}

// ── OpenWeather payload shapes (only the fields we read) ────────────────────
interface OwHour {
  dt: number;
  temp: number;
  feels_like: number;
  humidity: number;
  wind_speed: number;
  wind_deg: number;
  rain?: { "1h"?: number };
  snow?: { "1h"?: number };
  weather?: { main: string; description: string }[];
}
interface OwDay {
  dt: number;
  temp: { day: number };
  feels_like: { day: number };
  humidity: number;
  wind_speed: number;
  wind_deg: number;
  rain?: number;
  snow?: number;
  weather?: { main: string; description: string }[];
}
interface OwResponse {
  hourly?: OwHour[];
  daily?: OwDay[];
}

function mps_to_mph(mps: number): number {
  return Math.round(mps * 2.23694 * 10) / 10;
}
function c_to_f(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

// Build the RaceWeather from the hourly bucket nearest post + the 6h of rain
// before it (standing-water signal).
function fromHourly(hours: OwHour[], postMs: number): RaceWeather {
  let bestIdx = 0;
  let bestDelta = Infinity;
  hours.forEach((h, i) => {
    const delta = Math.abs(h.dt * 1000 - postMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  });
  const at = hours[bestIdx];
  const hourlyPrecip = (at.rain?.["1h"] ?? 0) + (at.snow?.["1h"] ?? 0);
  let priorAccum = 0;
  for (let i = Math.max(0, bestIdx - 6); i < bestIdx; i++) {
    priorAccum += (hours[i].rain?.["1h"] ?? 0) + (hours[i].snow?.["1h"] ?? 0);
  }
  return {
    tempF: c_to_f(at.temp),
    feelsLikeF: c_to_f(at.feels_like),
    conditions: at.weather?.[0]?.main ?? null,
    precipMm: Math.round(hourlyPrecip * 100) / 100,
    windMph: mps_to_mph(at.wind_speed),
    windDirDeg: Math.round(at.wind_deg),
    humidityPct: at.humidity,
    surfaceImpact: deriveSurfaceImpact(hourlyPrecip, priorAccum),
    fetchedAt: new Date().toISOString(),
    source: "openweather",
  };
}

// Daily fallback (post >48h out): the day bucket carries a single rain total, so
// we feed it as both the hourly and prior-accumulation signal.
function fromDaily(days: OwDay[], postMs: number): RaceWeather {
  let best = days[0];
  let bestDelta = Infinity;
  for (const d of days) {
    const delta = Math.abs(d.dt * 1000 - postMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = d;
    }
  }
  const precip = (best.rain ?? 0) + (best.snow ?? 0);
  return {
    tempF: c_to_f(best.temp.day),
    feelsLikeF: c_to_f(best.feels_like.day),
    conditions: best.weather?.[0]?.main ?? null,
    precipMm: Math.round(precip * 100) / 100,
    windMph: mps_to_mph(best.wind_speed),
    windDirDeg: Math.round(best.wind_deg),
    humidityPct: best.humidity,
    // A day total is coarse; treat the whole forecast accumulation as prior.
    surfaceImpact: deriveSurfaceImpact(0, precip),
    fetchedAt: new Date().toISOString(),
    source: "openweather",
  };
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function getRaceWeather(
  track: string,
  postTimeUtc: string,
): Promise<RaceWeather> {
  const loc = resolveTrackLocation(track);
  if (!loc) return unknownWeather();

  const postMs = new Date(postTimeUtc).getTime();
  if (Number.isNaN(postMs)) return unknownWeather();

  const cacheKey = `${loc.lat},${loc.lon}|${hourBucketUtc(postTimeUtc)}`;
  const cached = memCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const beyondHourly = postMs - Date.now() > HOURLY_HORIZON_MS;
  // Exclude the blocks we never read to keep the payload small.
  const exclude = beyondHourly ? "current,minutely,hourly,alerts" : "current,minutely,daily,alerts";
  const url =
    `${ONE_CALL_URL}?lat=${loc.lat}&lon=${loc.lon}` +
    `&exclude=${exclude}&units=metric&appid=${API_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return unknownWeather();
    const data = (await res.json()) as OwResponse;

    let value: RaceWeather;
    if (beyondHourly) {
      if (!data.daily?.length) return unknownWeather();
      value = fromDaily(data.daily, postMs);
    } else {
      if (!data.hourly?.length) return unknownWeather();
      value = fromHourly(data.hourly, postMs);
    }

    memCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return unknownWeather();
  }
}
