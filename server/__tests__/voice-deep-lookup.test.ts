// PR #28b — voice tools for deep features + track bias.
//
// Persists a fixture deep card into an isolated SQLite file, then exercises the
// two new voice handlers (lookup_runner_feature / lookup_track_bias) end-to-end:
// DB round-trip → reconstruct DeepRace → Fusion v3 feature compute → spoken JSON.

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";

// Isolated throwaway DB — set before importing db/services.
process.env.DATABASE_FILE = path.join(os.tmpdir(), `eea-deep-voice-${Date.now()}.db`);

import { parseDeepCardJson } from "../services/parsers/brisnet-deep";
import { persistDeepCard } from "../services/brisnet-deep-ingest";
import { lookupRunnerFeature, lookupTrackBias, type ToolContext } from "../services/voice-tools";
import type { CardWithRaces } from "@shared/schema";

const FIX = path.join(__dirname, "..", "services", "__fixtures__", "brisnet", "saratoga-2026-06-07.deep.json");

// Minimal CardWithRaces — only track/date/races[].raceNumber are read by the
// deep lookups. The rest of the shape is stubbed to satisfy the type.
function makeCtx(): ToolContext {
  const card = {
    id: 1,
    track: "SAR",
    date: "2026-06-07",
    races: [1, 2, 3, 4, 5, 6].map((n) => ({ raceNumber: n })),
  } as unknown as CardWithRaces;
  return { card, proposals: [] };
}

beforeAll(() => {
  const deep = parseDeepCardJson(readFileSync(FIX, "utf8"));
  const res = persistDeepCard(deep);
  expect(res.runners).toBeGreaterThan(0);
  expect(res.biasRows).toBeGreaterThan(0);
  expect(res.parsRows).toBe(6);
});

describe("lookup_runner_feature", () => {
  it("returns one named feature for a runner", () => {
    const out = lookupRunnerFeature(
      { raceNumber: 1, programNumber: "6", featureName: "bias_match" },
      makeCtx(),
    ) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    expect(out.feature).toBe("bias_match");
    expect(out.value).toBe(94);
    expect(out.horseName).toBe("Painted Stones");
  });

  it("accepts the _score suffix and shorthand interchangeably", () => {
    const a = lookupRunnerFeature({ raceNumber: 1, programNumber: "6", featureName: "dist_surf_form" }, makeCtx()) as Record<string, unknown>;
    const b = lookupRunnerFeature({ raceNumber: 1, programNumber: "6", featureName: "dist_surf_form_score" }, makeCtx()) as Record<string, unknown>;
    expect(a.value).toBe(88);
    expect(b.value).toBe(88);
  });

  it("returns all twelve features + composite + tier when no feature named", () => {
    const out = lookupRunnerFeature({ raceNumber: 1, programNumber: "6" }, makeCtx()) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    const f = out.features as Record<string, unknown>;
    expect(Object.keys(f)).toHaveLength(12);
    expect(out.composite).toBeCloseTo(72.5, 1);
    expect(out.tier).toBe("EDGE");
  });

  it("computes honesty_check in field context (top vs second)", () => {
    const out = lookupRunnerFeature({ raceNumber: 1, programNumber: "6", featureName: "honesty" }, makeCtx()) as Record<string, unknown>;
    expect(out.feature).toBe("honesty_check");
    expect(typeof out.value).toBe("boolean");
  });

  it("errors on an unknown feature name", () => {
    const out = lookupRunnerFeature({ raceNumber: 1, programNumber: "6", featureName: "vibes" }, makeCtx()) as Record<string, unknown>;
    expect(String(out.error)).toContain("Unknown feature");
  });

  it("errors on a runner not in the race", () => {
    const out = lookupRunnerFeature({ raceNumber: 1, programNumber: "99" }, makeCtx()) as Record<string, unknown>;
    expect(String(out.error)).toContain("not in race");
  });

  it("errors when the race has no deep data", () => {
    const out = lookupRunnerFeature({ raceNumber: 9, programNumber: "1" }, makeCtx()) as Record<string, unknown>;
    expect(String(out.error)).toContain("No Brisnet deep data");
  });
});

describe("lookup_track_bias", () => {
  it("returns the MEET-scope bias sheet by default", () => {
    const out = lookupTrackBias({ raceNumber: 1 }, makeCtx()) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    expect(out.scope).toBe("MEET");
    expect(out.styleImpact).toBeDefined();
    expect(out.postImpact).toBeDefined();
    expect(out.speedBiasPct).not.toBeNull();
  });

  it("returns the WEEK-scope sheet when asked", () => {
    const out = lookupTrackBias({ raceNumber: 1, scope: "week" }, makeCtx()) as Record<string, unknown>;
    expect(out.scope).toBe("WEEK");
  });

  it("defaults the race when none is given", () => {
    const out = lookupTrackBias({}, makeCtx()) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    expect(out.raceNumber).toBeDefined();
  });

  it("errors when no bias sheet exists for the race", () => {
    const out = lookupTrackBias({ raceNumber: 9 }, makeCtx()) as Record<string, unknown>;
    expect(String(out.error)).toContain("No Brisnet Track Bias");
  });
});
