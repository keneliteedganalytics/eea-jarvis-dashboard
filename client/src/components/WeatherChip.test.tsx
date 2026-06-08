// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WeatherChip } from "./WeatherChip";
import type { RaceWeather, SurfaceImpact } from "@shared/schema";

function makeWeather(surface: SurfaceImpact): RaceWeather {
  if (surface === "unknown") {
    return {
      tempF: null,
      feelsLikeF: null,
      conditions: null,
      precipMm: null,
      windMph: null,
      windDirDeg: null,
      humidityPct: null,
      surfaceImpact: "unknown",
      fetchedAt: "2026-06-08T12:00:00.000Z",
      source: "openweather",
    };
  }
  return {
    tempF: 68,
    feelsLikeF: 65,
    conditions: surface === "dry" ? "Clear" : "Rain",
    precipMm: surface === "dry" ? 0 : 3,
    windMph: 8,
    windDirDeg: 180,
    humidityPct: 55,
    surfaceImpact: surface,
    fetchedAt: "2026-06-08T12:00:00.000Z",
    source: "openweather",
  };
}

function renderChip(weather?: RaceWeather | null) {
  return render(
    <TooltipProvider>
      <WeatherChip weather={weather} />
    </TooltipProvider>,
  );
}

afterEach(() => cleanup());

describe("WeatherChip", () => {
  const states: { surface: SurfaceImpact; label: string }[] = [
    { surface: "dry", label: "DRY" },
    { surface: "damp", label: "DAMP" },
    { surface: "wet", label: "WET" },
    { surface: "sloppy", label: "SLOPPY" },
    { surface: "muddy", label: "MUDDY" },
  ];

  for (const { surface, label } of states) {
    it(`renders the ${surface} state with temp + label`, () => {
      renderChip(makeWeather(surface));
      const chip = screen.getByTestId(`weather-chip-${surface}`);
      expect(chip).toBeTruthy();
      expect(chip.textContent).toContain(label);
      expect(chip.textContent).toContain("68°");
    });
  }

  it("renders unknown greyed out with an em dash and no temp", () => {
    renderChip(makeWeather("unknown"));
    const chip = screen.getByTestId("weather-chip-unknown");
    expect(chip.textContent).toContain("—");
    expect(chip.textContent).not.toContain("°");
    expect(chip.className).toContain("opacity-60");
  });

  it("treats a null/missing weather prop as unknown", () => {
    renderChip(null);
    expect(screen.getByTestId("weather-chip-unknown")).toBeTruthy();
  });
});
