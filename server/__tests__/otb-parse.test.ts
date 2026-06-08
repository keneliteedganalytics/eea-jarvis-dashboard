import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseOtbFingerLakes } from "../services/otb-finger-lakes";

const FIXTURE = path.resolve(
  process.cwd(),
  "server/services/__fixtures__/otb-finger-lakes-sample.html",
);

describe("parseOtbFingerLakes — fixture", () => {
  const html = fs.readFileSync(FIXTURE, "utf-8");
  const data = parseOtbFingerLakes(html, "2026-06-08T18:00:00.000Z");

  it("parses the page date and fetchedAt", () => {
    expect(data).not.toBeNull();
    expect(data!.date).toBe("2026-06-08");
    expect(data!.fetchedAt).toBe("2026-06-08T18:00:00.000Z");
  });

  it("extracts scratches with race/program/horse", () => {
    expect(data!.scratches).toEqual([
      { race: 1, program: "3", horse: "Scottish Lassie" },
      { race: 3, program: "7", horse: "Late Mover" },
      { race: 5, program: "2", horse: "Gate Trouble" },
    ]);
  });

  it("extracts conditions", () => {
    expect(data!.conditions).toMatchObject({ surface: "Dirt", condition: "Fast" });
    expect(data!.conditions?.notes).toMatch(/Rail/);
  });

  it("extracts per-race finishing orders", () => {
    expect(data!.results).toHaveLength(2);
    const r1 = data!.results.find((r) => r.race === 1)!;
    expect(r1.finishers[0]).toEqual({ pos: 1, program: "4", horse: "Tapit Trice" });
    expect(r1.finishers).toHaveLength(3);
  });

  it("extracts payouts and purses", () => {
    expect(data!.payouts.find((p) => p.race === 1)).toEqual({
      race: 1,
      win: 8.4,
      place: 4.2,
      show: 3.1,
    });
    expect(data!.purses.find((p) => p.race === 2)).toEqual({ race: 2, purse: 13500 });
  });

  it("returns a non-null object even when sections are missing", () => {
    const out = parseOtbFingerLakes("<html><body></body></html>", "2026-06-08T18:00:00.000Z");
    expect(out).not.toBeNull();
    expect(out!.scratches).toEqual([]);
    expect(out!.conditions).toBeNull();
    expect(out!.results).toEqual([]);
  });
});
