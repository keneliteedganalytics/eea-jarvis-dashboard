// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PedigreeChip } from "./PedigreeChip";
import type { PedigreeSummary, BloodstockConfidence } from "@shared/schema";

function makePedigree(
  confidence: BloodstockConfidence,
  overrides: Partial<PedigreeSummary> = {},
): PedigreeSummary {
  return {
    composite: 78,
    confidence,
    applied: confidence !== "none",
    reasonCodes: ["sire-turf(Kitten's Joy)"],
    sireName: "Kitten's Joy",
    damName: "Some Dam",
    damSireName: "War Front",
    surfaceFit: 80,
    distanceFit: 72,
    wetFit: 55,
    ...overrides,
  };
}

function renderChip(pedigree?: PedigreeSummary | null) {
  return render(
    <TooltipProvider>
      <PedigreeChip pedigree={pedigree} />
    </TooltipProvider>,
  );
}

afterEach(() => cleanup());

describe("PedigreeChip", () => {
  const applied: BloodstockConfidence[] = ["high", "medium", "low"];

  for (const c of applied) {
    it(`renders the ${c} confidence state with the composite number`, () => {
      renderChip(makePedigree(c));
      const chip = screen.getByTestId(`pedigree-chip-${c}`);
      expect(chip).toBeTruthy();
      expect(chip.textContent).toContain("⚭");
      expect(chip.textContent).toContain("78");
    });
  }

  it("renders the none state greyed with an em dash and no composite", () => {
    renderChip(makePedigree("none"));
    const chip = screen.getByTestId("pedigree-chip-none");
    expect(chip.textContent).toContain("—");
    expect(chip.textContent).not.toContain("78");
    expect(chip.className).toContain("opacity-60");
  });

  it("treats a null/missing pedigree prop as none", () => {
    renderChip(null);
    expect(screen.getByTestId("pedigree-chip-none")).toBeTruthy();
  });

  it("renders as none when confidence is set but the factor never applied", () => {
    renderChip(makePedigree("high", { applied: false }));
    expect(screen.getByTestId("pedigree-chip-none")).toBeTruthy();
  });
});
