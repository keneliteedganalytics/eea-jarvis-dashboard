import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseOtbResults,
  trackSlug,
  slugify,
  otbResultsUrl,
} from "../services/otb-results";

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "../services/__fixtures__/otb-results-finger-lakes.html"),
  "utf8",
);

describe("otb-results parser", () => {
  const card = parseOtbResults(FIXTURE, "Finger Lakes", "2026-06-03", "2026-06-03T18:00:00Z");

  it("parses every race block on the page", () => {
    expect(card).not.toBeNull();
    expect(card!.track).toBe("Finger Lakes");
    expect(card!.date).toBe("2026-06-03");
    expect(card!.races.map((r) => r.raceNumber)).toEqual([1, 2, 3]);
  });

  it("R1 finish order 5-6-1-3 with WPS + exacta 5-6 $5.38", () => {
    const r1 = card!.races.find((r) => r.raceNumber === 1)!;
    expect(r1.isOfficial).toBe(true);
    expect(r1.finishOrder).toEqual(["5", "6", "1", "3"]);
    expect(r1.winPgm).toBe("5");
    expect(r1.winPayout).toBe(8.4);
    expect(r1.placePayout).toBe(4.2);
    expect(r1.showPayout).toBe(3.1);
    expect(r1.exactaCombo).toBe("5-6");
    expect(r1.exactaPayout).toBe(5.38);
    expect(r1.superfectaPayout).toBe(310.4);
    expect(r1.finishers[0]).toMatchObject({ pgm: "5", horse: "Iron Maiden", jockey: "L. Reyes" });
  });

  it("R2 carries exacta/trifecta/superfecta + daily double", () => {
    const r2 = card!.races.find((r) => r.raceNumber === 2)!;
    expect(r2.finishOrder).toEqual(["2", "1", "3", "4"]);
    expect(r2.exactaPayout).toBe(11.2);
    expect(r2.trifectaPayout).toBe(58.75);
    expect(r2.superfectaPayout).toBe(402);
    expect(r2.dailyDoublePayout).toBe(24.8);
  });

  it("R3 is the 'No results yet' sentinel → not official, empty finish order", () => {
    const r3 = card!.races.find((r) => r.raceNumber === 3)!;
    expect(r3.isOfficial).toBe(false);
    expect(r3.finishOrder).toEqual([]);
  });

  it("never throws on garbage HTML — returns a card with no races", () => {
    const out = parseOtbResults("<html><body>nope</body></html>", "X", "2026-01-01", "t");
    expect(out).not.toBeNull();
    expect(out!.races).toEqual([]);
  });
});

describe("track slug map", () => {
  it("maps explicit tracks case-insensitively", () => {
    expect(trackSlug("Finger Lakes")).toBe("finger-lakes");
    expect(trackSlug("FINGER LAKES")).toBe("finger-lakes");
    expect(trackSlug("Belmont")).toBe("belmont-park");
    expect(trackSlug("Gulfstream")).toBe("gulfstream-park");
    expect(trackSlug("Santa Anita")).toBe("santa-anita");
    expect(trackSlug("Tampa Bay Downs")).toBe("tampa-bay-downs");
    expect(trackSlug("Oaklawn")).toBe("oaklawn-park");
    expect(trackSlug("Del Mar")).toBe("del-mar");
  });

  it("falls back to slugify for unknown tracks", () => {
    expect(trackSlug("Penn National")).toBe("penn-national");
    expect(slugify("  Some  Weird Track! ")).toBe("some-weird-track");
  });

  it("builds the historical date-pattern URL", () => {
    expect(otbResultsUrl("Finger Lakes", "2026-06-03")).toBe(
      "https://www.offtrackbetting.com/results/finger-lakes/2026-06-03.html",
    );
  });

  it("builds the track-id URL for the live (today) page", () => {
    // Pin "now" so the date equals the requested date → live-day branch.
    const now = Date.parse("2026-06-09T18:00:00Z");
    expect(otbResultsUrl("Finger Lakes", "2026-06-09", now)).toBe(
      "https://www.offtrackbetting.com/results/30/finger-lakes.html",
    );
  });

  it("falls back to the date URL today for a track with no known track-id", () => {
    const now = Date.parse("2026-06-09T18:00:00Z");
    expect(otbResultsUrl("Penn National", "2026-06-09", now)).toBe(
      "https://www.offtrackbetting.com/results/penn-national/2026-06-09.html",
    );
  });
});
