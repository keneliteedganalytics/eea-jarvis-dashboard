import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { parseBrisnetPdf } from "../services/parsers/brisnet";
import { parseEquibasePdf } from "../services/parsers/equibase";

const FIXTURES = path.resolve(process.cwd(), "test-fixtures");
const BRIS = path.join(FIXTURES, "brisnet-fingerlakes.pdf");
const EQUI = path.join(FIXTURES, "equibase-saratoga.pdf");

const hasBris = fs.existsSync(BRIS);
const hasEqui = fs.existsSync(EQUI);

describe.skipIf(!hasBris)("parseBrisnetPdf", () => {
  it("extracts multiple races with non-empty rosters and prime power", async () => {
    const card = await parseBrisnetPdf(BRIS, "Finger Lakes", "2026-06-08");
    expect(card.races.length).toBeGreaterThan(0);

    for (const race of card.races) {
      expect(race.horses.length).toBeGreaterThan(0);
      for (const h of race.horses) {
        expect(h.pgm).toMatch(/^\d/);
        expect(h.name.length).toBeGreaterThan(0);
      }
    }

    // Prime power should be recovered for the large majority of horses.
    const all = card.races.flatMap((r) => r.horses);
    const withPP = all.filter((h) => h.primePower != null);
    expect(withPP.length / all.length).toBeGreaterThan(0.8);
  }, 30_000);
});

describe.skipIf(!hasEqui)("parseEquibasePdf", () => {
  it("extracts races with horses carrying program numbers", async () => {
    const card = await parseEquibasePdf(EQUI, "Saratoga", "2026-06-08");
    expect(card.races.length).toBeGreaterThan(0);
    const withHorses = card.races.filter((r) => r.horses.length > 0);
    expect(withHorses.length).toBeGreaterThan(0);
    for (const h of withHorses[0].horses) {
      expect(h.pgm.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
