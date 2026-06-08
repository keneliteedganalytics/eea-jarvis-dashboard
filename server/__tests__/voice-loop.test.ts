import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import { processVoiceTurn, type VoiceCardContext } from "../services/voice-persona";

vi.mock("../services/weather", () => ({
  getRaceWeather: vi.fn(async () => ({
    tempF: 71,
    feelsLikeF: 69,
    conditions: "Rain",
    precipMm: 4.2,
    windMph: 8,
    windDirDeg: 200,
    humidityPct: 80,
    surfaceImpact: "sloppy",
    fetchedAt: "2026-06-08T18:00:00.000Z",
    source: "openweather",
  })),
}));

// ── Minimal card fixture ─────────────────────────────────────────────────────
function race(n: number, tier: string, winPgm: string, winName: string): RaceWithResult {
  return {
    id: n * 10,
    cardId: 1,
    raceNumber: n,
    tier,
    post: "1:00 PM",
    postTimeUtc: "2026-06-08T17:00:00.000Z",
    conditions: "ALW 60000 6F DIRT",
    shape: null,
    read: null,
    flags: "[]",
    winPgm,
    winName,
    winScore: 100,
    placePgm: "2",
    placeName: "Bravo",
    placeScore: 90,
    showPgm: "7",
    showName: "Charlie",
    showScore: 80,
    fourthPgm: "1",
    fourthName: "Delta",
    fourthScore: 70,
    whyText: null,
    paceText: null,
    tierDemotedBy: null,
    weather: null,
    pedigree: {},
    result: null,
  } as RaceWithResult;
}

const CTX: VoiceCardContext = {
  card: {
    id: 1,
    track: "Saratoga",
    date: "2026-06-08",
    cardConviction: "HIGH",
    notes: null,
    locked: false,
    status: "active",
    archivedAt: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    races: [
      race(1, "PASS", "3", "Scottish Lassie"),
      race(2, "DUAL", "4", "Tapit Trice"),
      race(3, "EDGE", "5", "Curlins Pride"),
    ],
  } as CardWithRaces,
  activeRaceNumber: 2,
};

// A scripted mock Anthropic client: messages.create returns the next queued
// response each call. Each response is { content, stop_reason }.
function mockClient(responses: Array<{ content: any[]; stop_reason: string }>) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("mock ran out of responses");
    return next as unknown as Anthropic.Message;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function text(t: string) {
  return { type: "text", text: t };
}
function toolUse(id: string, name: string, input: unknown) {
  return { type: "tool_use", id, name, input };
}

describe("processVoiceTurn — tool loop + two-voice routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("question intent → weather tool → final text → voice=scarlett, no proposals", async () => {
    const { client, create } = mockClient([
      { content: [toolUse("t1", "get_track_weather", {})], stop_reason: "tool_use" },
      { content: [text("Track's gone sloppy at the Spa, 71 and raining. Watch the closers.")], stop_reason: "end_turn" },
    ]);

    const out = await processVoiceTurn("what's the weather?", CTX, [], {
      client,
      model: "claude-sonnet-4-5",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(out.voice).toBe("scarlett");
    expect(out.proposedChanges).toHaveLength(0);
    expect(out.needsConfirmation).toBe(false);
    expect(out.toolsUsed).toEqual(["get_track_weather"]);
    expect(out.spokenResponse).toMatch(/sloppy/i);
  });

  it("tier-change intent → propose_tier_change → voice=jarvis + proposedChanges populated", async () => {
    const { client } = mockClient([
      {
        content: [
          toolUse("t1", "propose_tier_change", {
            raceNumber: 2,
            horsePgm: "4",
            newTier: "SNIPER",
            reason: "lone speed after the scratch",
          }),
        ],
        stop_reason: "tool_use",
      },
      { content: [text("The four's all alone on the lead now — bumping him to SNIPER. Confirm?")], stop_reason: "end_turn" },
    ]);

    const out = await processVoiceTurn("bump the 4 to sniper", CTX, [], {
      client,
      model: "claude-sonnet-4-5",
    });

    expect(out.voice).toBe("jarvis");
    expect(out.proposedChanges).toHaveLength(1);
    expect(out.proposedChanges[0]).toMatchObject({
      race_number: 2,
      old_tier: "DUAL",
      new_tier: "SNIPER",
    });
    expect(out.needsConfirmation).toBe(true);
  });

  it("processes a multi-tool response in one round", async () => {
    const { client, create } = mockClient([
      {
        content: [
          toolUse("t1", "get_card_overview", {}),
          toolUse("t2", "get_top_picks", { tier: ["EDGE"] }),
        ],
        stop_reason: "tool_use",
      },
      { content: [text("Three races today; the five in the third is your EDGE play.")], stop_reason: "end_turn" },
    ]);

    const out = await processVoiceTurn("give me the briefing", CTX, [], {
      client,
      model: "claude-sonnet-4-5",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(out.toolsUsed).toEqual(["get_card_overview", "get_top_picks"]);
    expect(out.voice).toBe("scarlett");
  });

  it("caps tool-call rounds at 4 and still returns a final text reply", async () => {
    // Always ask for a tool. The loop should call create at most 5 times
    // (4 tool rounds + 1 forced no-tools final), and the 5th has no tools so
    // the model is forced to answer in text.
    const responses: Array<{ content: any[]; stop_reason: string }> = [];
    for (let i = 0; i < 4; i++) {
      responses.push({ content: [toolUse(`t${i}`, "get_card_overview", {})], stop_reason: "tool_use" });
    }
    // 5th call (atCap, tools dropped) returns text.
    responses.push({ content: [text("Here's the card.")], stop_reason: "end_turn" });

    const { client, create } = mockClient(responses);
    const out = await processVoiceTurn("loop forever", CTX, [], {
      client,
      model: "claude-sonnet-4-5",
    });

    expect(create).toHaveBeenCalledTimes(5);
    expect(out.rounds).toBe(4);
    expect(out.spokenResponse).toBe("Here's the card.");

    // The final create call must have been made WITHOUT tools (forced answer).
    const lastCallArg = create.mock.calls[create.mock.calls.length - 1][0] as any;
    expect(lastCallArg.tools).toBeUndefined();
  });
});
