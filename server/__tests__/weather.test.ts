import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getRaceWeather,
  deriveSurfaceImpact,
  resolveTrackLocation,
  hourBucketUtc,
  clearWeatherCache,
  SURFACE_THRESHOLDS,
} from "../services/weather";

// A minimal OpenWeather One Call hourly entry in metric units.
function owHour(
  dtMs: number,
  opts: Partial<{ temp: number; feels: number; humidity: number; wind: number; deg: number; rain: number; main: string }> = {},
) {
  return {
    dt: Math.floor(dtMs / 1000),
    temp: opts.temp ?? 20,
    feels_like: opts.feels ?? 20,
    humidity: opts.humidity ?? 60,
    wind_speed: opts.wind ?? 4,
    wind_deg: opts.deg ?? 180,
    rain: opts.rain != null ? { "1h": opts.rain } : undefined,
    weather: [{ main: opts.main ?? "Clear", description: "" }],
  };
}

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  clearWeatherCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearWeatherCache();
});

describe("deriveSurfaceImpact thresholds", () => {
  it("classifies dry/damp/wet/sloppy/muddy by combined accumulation", () => {
    expect(deriveSurfaceImpact(0, 0)).toBe("dry");
    expect(deriveSurfaceImpact(0.1, 0)).toBe("dry");
    expect(deriveSurfaceImpact(SURFACE_THRESHOLDS.damp, 0)).toBe("damp");
    expect(deriveSurfaceImpact(1, 0)).toBe("damp");
    expect(deriveSurfaceImpact(SURFACE_THRESHOLDS.wet, 0)).toBe("wet");
    expect(deriveSurfaceImpact(0, 5)).toBe("wet");
    expect(deriveSurfaceImpact(SURFACE_THRESHOLDS.sloppy, 0)).toBe("sloppy");
    expect(deriveSurfaceImpact(4, 6)).toBe("sloppy"); // prior accum pushes to sloppy
    expect(deriveSurfaceImpact(SURFACE_THRESHOLDS.muddy, 0)).toBe("muddy");
    expect(deriveSurfaceImpact(20, 10)).toBe("muddy");
  });
});

describe("resolveTrackLocation", () => {
  it("resolves by code and by full name (case-insensitive)", () => {
    expect(resolveTrackLocation("SAR")?.name).toBe("Saratoga");
    expect(resolveTrackLocation("Saratoga")?.lat).toBeCloseTo(43.07, 1);
    expect(resolveTrackLocation("fl")?.name).toBe("Finger Lakes");
    expect(resolveTrackLocation("Nowhere Downs")).toBeNull();
  });
});

describe("getRaceWeather — happy path", () => {
  it("picks the hourly bucket nearest post and derives surfaceImpact", async () => {
    const now = new Date("2026-06-08T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const postMs = now + 2 * 60 * 60 * 1000; // 2h out → hourly path

    // 7 hours so the post-hour has 6 prior buckets. Soak the 6 prior hours so the
    // surface comes back sloppy (prior accum dominates).
    const hours = [];
    for (let i = -6; i <= 1; i++) {
      hours.push(owHour(postMs + i * 3600_000, { rain: 1.2, temp: 18, feels: 16, main: "Rain", deg: 200, wind: 5 }));
    }
    const fetchMock = vi.fn().mockReturnValue(jsonResponse({ hourly: hours }));
    vi.stubGlobal("fetch", fetchMock);

    const w = await getRaceWeather("SAR", new Date(postMs).toISOString());
    expect(w.source).toBe("openweather");
    expect(w.surfaceImpact).toBe("sloppy"); // ~6*1.2 + 1.2 = 8.4mm
    expect(w.tempF).toBe(64); // 18C
    expect(w.windMph).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Hourly path keeps the hourly block (excludes daily).
    expect(String(fetchMock.mock.calls[0][0])).toContain("exclude=current,minutely,daily,alerts");
  });

  it("caches by hour bucket — second call within 30 min does not refetch", async () => {
    const now = new Date("2026-06-08T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const postMs = now + 2 * 60 * 60 * 1000;
    const hours = [owHour(postMs, { rain: 0 })];
    const fetchMock = vi.fn().mockReturnValue(jsonResponse({ hourly: hours }));
    vi.stubGlobal("fetch", fetchMock);

    await getRaceWeather("SAR", new Date(postMs).toISOString());
    await getRaceWeather("SAR", new Date(postMs + 5 * 60 * 1000).toISOString()); // same hour
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("getRaceWeather — 48h+ fallback to daily", () => {
  it("uses the daily array when post is beyond the hourly horizon", async () => {
    const now = new Date("2026-06-08T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const postMs = now + 72 * 60 * 60 * 1000; // 72h out → daily path

    const daily = [
      {
        dt: Math.floor(postMs / 1000),
        temp: { day: 25 },
        feels_like: { day: 26 },
        humidity: 50,
        wind_speed: 3,
        wind_deg: 90,
        rain: 9,
        weather: [{ main: "Rain", description: "" }],
      },
    ];
    const fetchMock = vi.fn().mockReturnValue(jsonResponse({ daily }));
    vi.stubGlobal("fetch", fetchMock);

    const w = await getRaceWeather("SAR", new Date(postMs).toISOString());
    // Daily path keeps the daily block (excludes hourly).
    expect(String(fetchMock.mock.calls[0][0])).toContain("exclude=current,minutely,hourly,alerts");
    expect(w.surfaceImpact).toBe("sloppy"); // 9mm day total → 7 <= 9 < 15
    expect(w.tempF).toBe(77); // 25C
  });
});

describe("getRaceWeather — failure modes never throw", () => {
  it("returns unknown when OpenWeather responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(jsonResponse({}, false)));
    const w = await getRaceWeather("SAR", new Date(Date.now() + 3600_000).toISOString());
    expect(w.surfaceImpact).toBe("unknown");
    expect(w.tempF).toBeNull();
    expect(w.source).toBe("openweather");
  });

  it("returns unknown when fetch rejects (network down)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const w = await getRaceWeather("SAR", new Date(Date.now() + 3600_000).toISOString());
    expect(w.surfaceImpact).toBe("unknown");
  });

  it("returns unknown for an unmapped track without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const w = await getRaceWeather("ZZ", new Date(Date.now() + 3600_000).toISOString());
    expect(w.surfaceImpact).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hourBucketUtc", () => {
  it("floors to the UTC hour", () => {
    expect(hourBucketUtc("2026-06-08T14:37:12Z")).toBe("2026-06-08T14:00:00.000Z");
  });
});
