// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { TrackRecordHero, type TrackRecordSummary } from "./TrackRecordHero";

// Per-timeframe fixtures the mocked endpoint returns.
const FIXTURES: Record<string, TrackRecordSummary> = {
  "30D": {
    timeframe: "30D",
    wins: 12,
    plays: 40,
    winPct: 30,
    units: 8.4,
    roi: 21,
    tiers: [
      { tier: "SNIPER", wins: 17, plays: 23, units: 14.2 },
      { tier: "EDGE", wins: 22, plays: 41, units: 3.1 },
      { tier: "DUAL", wins: 11, plays: 25, units: -2.5 },
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  },
  "7D": {
    timeframe: "7D",
    wins: 3,
    plays: 9,
    winPct: 33,
    units: -1.2,
    roi: -13.3,
    tiers: [
      { tier: "SNIPER", wins: 2, plays: 3, units: 2.0 },
      { tier: "EDGE", wins: 1, plays: 4, units: -1.5 },
      { tier: "DUAL", wins: 0, plays: 2, units: -1.7 },
    ],
    generatedAt: "2026-06-08T00:00:00.000Z",
  },
};

function renderHero() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, staleTime: Infinity },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <TrackRecordHero />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const tf = new URL(url, "http://localhost").searchParams.get("timeframe") ?? "30D";
      return {
        ok: true,
        status: 200,
        json: async () => FIXTURES[tf] ?? FIXTURES["30D"],
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("TrackRecordHero", () => {
  it("renders the overall record, ROI, and units from mocked 30D data (default)", async () => {
    renderHero();
    await waitFor(() => expect(screen.getByTestId("hero-record")).toHaveTextContent("12/40"));
    expect(screen.getByTestId("hero-roi")).toHaveTextContent("+21%");
    expect(screen.getByTestId("hero-units")).toHaveTextContent("+8.4u");
  });

  it("defaults the timeframe selector to 30D", async () => {
    renderHero();
    await waitFor(() => expect(screen.getByTestId("hero-tf-30D")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("hero-tf-7D")).toHaveAttribute("aria-selected", "false");
  });

  it("renders the SNIPER/EDGE/DUAL tier breakdown mini-row", async () => {
    renderHero();
    await waitFor(() => expect(screen.getByTestId("hero-tier-SNIPER")).toBeInTheDocument());
    // SNIPER 17-6 (wins-losses) +14.2u
    expect(screen.getByTestId("hero-tier-SNIPER")).toHaveTextContent("17-6");
    expect(screen.getByTestId("hero-tier-SNIPER")).toHaveTextContent("+14.2u");
    expect(screen.getByTestId("hero-tier-DUAL")).toHaveTextContent("-2.5u");
  });

  it("swaps the displayed numbers when a different timeframe is selected", async () => {
    renderHero();
    await waitFor(() => expect(screen.getByTestId("hero-record")).toHaveTextContent("12/40"));

    fireEvent.click(screen.getByTestId("hero-tf-7D"));

    await waitFor(() => expect(screen.getByTestId("hero-record")).toHaveTextContent("3/9"));
    expect(screen.getByTestId("hero-roi")).toHaveTextContent("-13.3%");
    expect(screen.getByTestId("hero-units")).toHaveTextContent("-1.2u");
    expect(screen.getByTestId("hero-tf-7D")).toHaveAttribute("aria-selected", "true");
  });
});
