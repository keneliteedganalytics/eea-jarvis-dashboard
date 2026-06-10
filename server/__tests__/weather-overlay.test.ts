import { describe, it, expect } from "vitest";
import {
  classifyCondition,
  summarizeNwsGrid,
  resolveTrackCoords,
  conditionToSurfaceImpact,
  type NwsGridResponse,
} from "../services/weather-overlay";

describe("classifyCondition", () => {
  it("maps PoP≥50% and rainfall≥0.10\" to sloppy", () => {
    expect(classifyCondition(60, 0.2)).toBe("sloppy");
    expect(classifyCondition(50, 0.1)).toBe("sloppy");
  });
  it("maps PoP≥30% and rainfall≥0.05\" to good", () => {
    expect(classifyCondition(40, 0.07)).toBe("good");
    expect(classifyCondition(30, 0.05)).toBe("good");
  });
  it("falls back to fast below the thresholds", () => {
    expect(classifyCondition(20, 0.5)).toBe("fast"); // low PoP
    expect(classifyCondition(80, 0.02)).toBe("fast"); // low rain
    expect(classifyCondition(0, 0)).toBe("fast");
  });
  it("requires BOTH PoP and rainfall — high rain alone is not sloppy", () => {
    // 45% PoP misses the 50% sloppy gate but clears the 30% good gate.
    expect(classifyCondition(45, 0.3)).toBe("good");
  });
});

describe("resolveTrackCoords", () => {
  it("resolves Finger Lakes / FLX to Farmington NY coords", () => {
    expect(resolveTrackCoords("Finger Lakes")).toEqual({ lat: 42.9856, lon: -77.3097 });
    expect(resolveTrackCoords("FLX")).toEqual({ lat: 42.9856, lon: -77.3097 });
    expect(resolveTrackCoords("finger lakes")).toEqual({ lat: 42.9856, lon: -77.3097 });
  });
  it("returns null for an unknown track (overlay stays inert)", () => {
    expect(resolveTrackCoords("Saratoga")).toBeNull();
  });
});

// A trimmed NWS gridpoint snapshot for Farmington NY today (2026-06-10): a
// rainy afternoon — 60% PoP and ~0.18" (4.6mm) of QPF in the next 6 hours.
const NWS_SNAPSHOT: NwsGridResponse = {
  properties: {
    probabilityOfPrecipitation: {
      uom: "wmoUnit:percent",
      values: [
        { validTime: "2026-06-10T14:00:00+00:00/PT1H", value: 30 },
        { validTime: "2026-06-10T15:00:00+00:00/PT2H", value: 60 },
        { validTime: "2026-06-10T17:00:00+00:00/PT1H", value: 55 },
        // Outside the 6h window — must be ignored.
        { validTime: "2026-06-11T06:00:00+00:00/PT1H", value: 90 },
      ],
    },
    quantitativePrecipitation: {
      uom: "wmoUnit:mm",
      values: [
        { validTime: "2026-06-10T15:00:00+00:00/PT1H", value: 1.5 },
        { validTime: "2026-06-10T16:00:00+00:00/PT1H", value: 2.0 },
        { validTime: "2026-06-10T17:00:00+00:00/PT1H", value: 1.1 },
        // Outside the window.
        { validTime: "2026-06-11T06:00:00+00:00/PT1H", value: 20.0 },
      ],
    },
  },
};

describe("summarizeNwsGrid", () => {
  const now = new Date("2026-06-10T14:30:00Z");

  it("reduces today's Farmington NY snapshot to peak PoP + 6h rainfall (mm→in)", () => {
    const { popPct, rainfallInches } = summarizeNwsGrid(NWS_SNAPSHOT, now);
    expect(popPct).toBe(60);
    // 1.5 + 2.0 + 1.1 = 4.6mm ≈ 0.181"
    expect(rainfallInches).toBeCloseTo(0.181, 2);
  });

  it("classifies today's Farmington NY forecast as sloppy", () => {
    const { popPct, rainfallInches } = summarizeNwsGrid(NWS_SNAPSHOT, now);
    expect(classifyCondition(popPct, rainfallInches)).toBe("sloppy");
  });

  it("handles QPF already reported in inches", () => {
    const grid: NwsGridResponse = {
      properties: {
        probabilityOfPrecipitation: {
          uom: "wmoUnit:percent",
          values: [{ validTime: "2026-06-10T15:00:00+00:00/PT1H", value: 55 }],
        },
        quantitativePrecipitation: {
          uom: "in",
          values: [{ validTime: "2026-06-10T15:00:00+00:00/PT1H", value: 0.12 }],
        },
      },
    };
    const { rainfallInches } = summarizeNwsGrid(grid, now);
    expect(rainfallInches).toBeCloseTo(0.12, 3);
  });

  it("returns zeros for an empty payload (caller degrades to fast)", () => {
    const { popPct, rainfallInches } = summarizeNwsGrid({}, now);
    expect(popPct).toBe(0);
    expect(rainfallInches).toBe(0);
    expect(classifyCondition(popPct, rainfallInches)).toBe("fast");
  });
});

describe("conditionToSurfaceImpact", () => {
  it("maps coarse conditions to fusion surface impacts", () => {
    expect(conditionToSurfaceImpact("sloppy")).toBe("sloppy");
    expect(conditionToSurfaceImpact("muddy")).toBe("muddy");
    expect(conditionToSurfaceImpact("wet-fast")).toBe("wet");
    expect(conditionToSurfaceImpact("fast")).toBe("dry");
    expect(conditionToSurfaceImpact("good")).toBe("dry");
    expect(conditionToSurfaceImpact(null)).toBe("unknown");
  });
});
