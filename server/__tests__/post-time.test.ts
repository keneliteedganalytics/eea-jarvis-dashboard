import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  parseClock,
  localToUtcIso,
  zoneForTrack,
  extractEquibasePostTime,
  extractBrisnetDrfPostTime,
  fallbackPostTime,
} from "../services/parsers/post-time";
import {
  parseDrfPostTimes,
  parseDrmZip,
  extractDrmZip,
} from "../services/parsers/brisnet-drm";

describe("parseClock", () => {
  it("parses explicit AM/PM", () => {
    expect(parseClock("12:55 PM")).toEqual({ hour24: 12, minute: 55 });
    expect(parseClock("9:05 AM")).toEqual({ hour24: 9, minute: 5 });
    expect(parseClock("12:30 AM")).toEqual({ hour24: 0, minute: 30 });
  });

  it("assumes afternoon for bare 1-9 (Brisnet local token)", () => {
    // "1:24" on a thoroughbred card is 1:24 PM, not 1:24 AM.
    expect(parseClock("1:24")).toEqual({ hour24: 13, minute: 24 });
    expect(parseClock("12:55")).toEqual({ hour24: 12, minute: 55 });
  });

  it("returns null for non-times", () => {
    expect(parseClock("no time here")).toBeNull();
    expect(parseClock("99:99")).toBeNull();
  });
});

describe("zoneForTrack", () => {
  it("maps known tracks and codes", () => {
    expect(zoneForTrack("Finger Lakes")).toBe("America/New_York");
    expect(zoneForTrack("FL")).toBe("America/New_York");
    expect(zoneForTrack("Santa Anita")).toBe("America/Los_Angeles");
    expect(zoneForTrack("SA")).toBe("America/Los_Angeles");
  });

  it("defaults unknown tracks to ET with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(zoneForTrack("Phantom Downs")).toBe("America/New_York");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("localToUtcIso — time zone handling", () => {
  it("ET and PT at the same wall clock produce different UTC", () => {
    const et = localToUtcIso("2026-06-08", 13, 0, "America/New_York");
    const pt = localToUtcIso("2026-06-08", 13, 0, "America/Los_Angeles");
    expect(et).not.toBe(pt);
    // June → EDT is UTC-4, PDT is UTC-7. 1:00 PM local.
    expect(et).toBe("2026-06-08T17:00:00.000Z");
    expect(pt).toBe("2026-06-08T20:00:00.000Z");
  });

  it("is DST-aware (summer EDT vs winter EST)", () => {
    const summer = localToUtcIso("2026-06-08", 13, 0, "America/New_York"); // EDT -4
    const winter = localToUtcIso("2026-01-08", 13, 0, "America/New_York"); // EST -5
    expect(summer).toBe("2026-06-08T17:00:00.000Z");
    expect(winter).toBe("2026-01-08T18:00:00.000Z");
  });
});

describe("extractEquibasePostTime", () => {
  it("parses 'Post Time: 12:55 PM ET'", () => {
    const pt = extractEquibasePostTime(
      "Post Time: 12:55 PM ET",
      "2026-06-08",
      "Finger Lakes",
    );
    expect(pt).not.toBeNull();
    expect(pt!.display).toBe("12:55 PM");
    expect(pt!.utcIso).toBe("2026-06-08T16:55:00.000Z");
  });

  it("returns null when no post-time token present", () => {
    expect(
      extractEquibasePostTime("Race Rating 88", "2026-06-08", "Saratoga"),
    ).toBeNull();
  });
});

describe("extractBrisnetDrfPostTime", () => {
  it("parses the parenthesized local value from the zone field", () => {
    const pt = extractBrisnetDrfPostTime(
      "(12:55)/11:55/10:55/ 9:55",
      "2026-06-08",
      "FL",
    );
    expect(pt).not.toBeNull();
    expect(pt!.display).toBe("12:55 PM");
    expect(pt!.utcIso).toBe("2026-06-08T16:55:00.000Z");
  });

  it("handles a later race ('( 4:18)' → 4:18 PM)", () => {
    const pt = extractBrisnetDrfPostTime(
      "( 4:18)/ 3:18/ 2:18/ 1:18",
      "2026-06-08",
      "FL",
    );
    expect(pt!.display).toBe("4:18 PM");
    expect(pt!.utcIso).toBe("2026-06-08T20:18:00.000Z");
  });
});

describe("fallbackPostTime — previous race + delta", () => {
  it("adds 28 minutes to the previous race's local time", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prev = extractBrisnetDrfPostTime(
      "(12:55)/11:55/10:55/ 9:55",
      "2026-06-08",
      "FL",
    );
    const next = fallbackPostTime(prev, "2026-06-08", "FL", 2);
    expect(next.display).toBe("1:23 PM"); // 12:55 + 28m
    expect(next.utcIso).toBe("2026-06-08T17:23:00.000Z");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses a conventional first post when no previous race exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = fallbackPostTime(null, "2026-06-08", "FL", 1);
    expect(first.display).toBe("12:30 PM");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── Real fixture: the Finger Lakes 2026-06-08 DRM zip carries a .DRF ──────────
const FIXTURE = path.resolve(
  process.cwd(),
  "server/services/__fixtures__/brisnet/flx0608n.zip",
);
const hasFixture = fs.existsSync(FIXTURE);

describe.skipIf(!hasFixture)("Brisnet DRF post times from real fixture", () => {
  it("parseDrfPostTimes extracts a local time for every race", () => {
    const files = extractDrmZip(fs.readFileSync(FIXTURE));
    expect(files.drf).toBeTruthy();
    const map = parseDrfPostTimes(files.drf!);
    expect(map.size).toBeGreaterThan(0);
    expect(map.get(1)).toBe("12:55");
    expect(map.get(8)).toBe("4:18");
  });

  it("parseDrmZip attaches postTimeRaw to every race", () => {
    const card = parseDrmZip(fs.readFileSync(FIXTURE), "FL");
    expect(card.races.length).toBeGreaterThan(0);
    for (const r of card.races) {
      expect(r.postTimeRaw, `race ${r.raceNumber}`).toBeTruthy();
    }
  });
});
