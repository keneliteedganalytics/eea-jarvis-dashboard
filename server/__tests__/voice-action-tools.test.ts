import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CardWithRaces } from "@shared/schema";
import type { ToolContext } from "../services/voice-tools";

// Mock the on-demand ingest so ingest_card_for_review is offline + deterministic.
vi.mock("../services/on-demand-ingest", () => ({
  runOnDemandIngest: vi.fn(),
}));
// Mock storage so lock_card has a deterministic updateCard.
vi.mock("../storage", () => ({
  storage: {
    updateCard: vi.fn(),
  },
}));

import { ingestCardForReview, lockCard, runTool } from "../services/voice-tools";
import { runOnDemandIngest } from "../services/on-demand-ingest";
import { storage } from "../storage";

function ctx(): ToolContext {
  return {
    card: { id: 1, track: "Finger Lakes", date: "2026-06-09", races: [] } as unknown as CardWithRaces,
    proposals: [],
    actions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingest_card_for_review handler", () => {
  it("returns a spoken summary and records the action on success", async () => {
    (runOnDemandIngest as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "success",
      cardId: 3,
      track: "Finger Lakes",
      date: "2026-06-09",
      raceCount: 8,
      conviction: "HIGH",
      sources: { equibase: { ok: true }, brisnet: { ok: true } },
      warnings: [],
      durationMs: 100,
    });
    const c = ctx();
    const out = (await ingestCardForReview({ track: "Finger Lakes", date: "2026-06-09" }, c)) as any;
    expect(out.cardId).toBe(3);
    expect(out.summary).toContain("Finger Lakes");
    expect(out.summary).toContain("lock card 3");
    expect(c.actions).toContain("ingest_card_for_review"); // routes to Jarvis voice
  });

  it("surfaces a partial result note", async () => {
    (runOnDemandIngest as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "partial",
      cardId: 4,
      track: "Finger Lakes",
      date: "2026-06-09",
      raceCount: 7,
      conviction: "MEDIUM",
      sources: { equibase: { ok: true }, brisnet: { ok: false } },
      warnings: ["Brisnet failed"],
      durationMs: 100,
    });
    const out = (await ingestCardForReview({ track: "Finger Lakes", date: "2026-06-09" }, ctx())) as any;
    expect(out.status).toBe("partial");
    expect(out.summary).toContain("Equibase-only");
  });

  it("returns an error when the ingest fails", async () => {
    (runOnDemandIngest as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "failed",
      track: "Nowhere",
      date: "2026-06-09",
      sources: { equibase: { ok: false }, brisnet: { ok: false } },
      warnings: ["Unknown track"],
      durationMs: 5,
    });
    const out = (await ingestCardForReview({ track: "Nowhere", date: "2026-06-09" }, ctx())) as any;
    expect(out.error).toBeTruthy();
  });

  it("requires both track and date", async () => {
    const out = (await ingestCardForReview({ track: "Finger Lakes" }, ctx())) as any;
    expect(out.error).toBeTruthy();
  });
});

describe("lock_card handler", () => {
  it("publishes the card and records the action", () => {
    (storage.updateCard as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 3,
      track: "Finger Lakes",
      date: "2026-06-09",
      locked: true,
    });
    const c = ctx();
    const out = lockCard({ cardId: 3 }, c) as any;
    expect(out.ok).toBe(true);
    expect(out.locked).toBe(true);
    expect(storage.updateCard).toHaveBeenCalledWith(3, { locked: true });
    expect(c.actions).toContain("lock_card");
  });

  it("errors when the card is not found", () => {
    (storage.updateCard as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const out = lockCard({ cardId: 99 }, ctx()) as any;
    expect(out.error).toContain("not found");
  });

  it("errors when no cardId is given", () => {
    const out = lockCard({}, ctx()) as any;
    expect(out.error).toBeTruthy();
  });
});

describe("runTool dispatch for new action tools", () => {
  it("routes ingest_card_for_review and lock_card through runTool", async () => {
    (runOnDemandIngest as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "success",
      cardId: 5,
      track: "Saratoga",
      date: "2026-06-09",
      raceCount: 9,
      conviction: "HIGH",
      sources: { equibase: { ok: true }, brisnet: { ok: true } },
      warnings: [],
      durationMs: 1,
    });
    (storage.updateCard as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5,
      track: "Saratoga",
      date: "2026-06-09",
      locked: true,
    });
    const c = ctx();
    const ingest = (await runTool("ingest_card_for_review", { track: "Saratoga", date: "2026-06-09" }, c)) as any;
    expect(ingest.cardId).toBe(5);
    const lock = (await runTool("lock_card", { cardId: 5 }, c)) as any;
    expect(lock.ok).toBe(true);
  });
});
