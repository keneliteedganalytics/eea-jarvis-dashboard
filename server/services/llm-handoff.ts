// LLM handoff — send a fused race + bias + maiden enrichment to the configured
// provider (Anthropic or Poe) and get back a structured handicap.
//
// Both providers are constrained to the same JSON schema: Anthropic via a
// single-tool tool_use call, Poe via the OpenAI-compatible
// response_format: { type: "json_schema" }. The system prompt is the active
// persona from formula_versions; the user message carries the structured race
// payload in <race_data> / <bias_card> / <maiden_data> tags so the model has a
// stable, parse-free view of the figures.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FusedRace } from "./eea-fusion";
import type { BiasCard } from "./bias-fetcher";
import type { EnrichmentResult } from "./maiden-enrichment";

// ── Structured output contract ──────────────────────────────────────────────
export const handicapSchema = z.object({
  executiveSummary: z.string(),
  top4: z
    .array(
      z.object({
        pgm: z.string(),
        horseName: z.string(),
        rank: z.number().int(),
        whyBullets: z.array(z.string()).min(1).max(5),
        paceMatchup: z.string(),
      }),
    )
    .min(1)
    .max(4),
  bettingStrategy: z.string(),
  tier: z.enum(["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]),
  suggestedWagers: z
    .array(
      z.object({
        type: z.string(),
        horses: z.array(z.string()),
        amount: z.number(),
      }),
    )
    .optional(),
});

export type Handicap = z.infer<typeof handicapSchema>;

// JSON Schema mirror of handicapSchema for the provider tool/response_format.
const HANDICAP_JSON_SCHEMA = {
  type: "object",
  properties: {
    executiveSummary: { type: "string" },
    top4: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          pgm: { type: "string" },
          horseName: { type: "string" },
          rank: { type: "integer" },
          whyBullets: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
          paceMatchup: { type: "string" },
        },
        required: ["pgm", "horseName", "rank", "whyBullets", "paceMatchup"],
      },
    },
    bettingStrategy: { type: "string" },
    tier: { type: "string", enum: ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] },
    suggestedWagers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          horses: { type: "array", items: { type: "string" } },
          amount: { type: "number" },
        },
      },
    },
  },
  required: ["executiveSummary", "top4", "bettingStrategy", "tier"],
} as const;

export type LlmProvider = "anthropic" | "poe";

export interface HandoffConfig {
  provider: LlmProvider;
  anthropicApiKey: string;
  poeApiKey: string;
  anthropicModel: string;
  poeModel: string;
  persona: string;
}

export interface RacePayload {
  fused: FusedRace;
  bias: BiasCard | null;
  maidens: EnrichmentResult[];
}

// Build the user message: structured payload in tagged blocks.
function buildUserMessage(p: RacePayload): string {
  const raceData = {
    raceNumber: p.fused.raceNumber,
    raceType: p.fused.raceType,
    projectedShape: p.fused.shapeNote,
    conditions: p.fused.conditions,
    horses: p.fused.horses.map((h) => ({
      pgm: h.pgm,
      name: h.name,
      eeas: h.eeas,
      eeap: h.eeap,
      eeapFit: h.eeapFit,
      eeac: h.eeac,
      eeaRating: h.eeaRating,
      rank: h.rank,
      flags: h.flags,
    })),
  };
  const parts = [
    "<race_data>",
    JSON.stringify(raceData, null, 2),
    "</race_data>",
    "<bias_card>",
    p.bias ? JSON.stringify(p.bias, null, 2) : "No prior-day bias available.",
    "</bias_card>",
    "<maiden_data>",
    p.maidens.length ? JSON.stringify(p.maidens, null, 2) : "Not a maiden race / no enrichment.",
    "</maiden_data>",
    "",
    "Produce the structured handicap for this race. Use only the figures provided. PASS is acceptable.",
  ];
  return parts.join("\n");
}

// ── Anthropic ───────────────────────────────────────────────────────────────
async function callAnthropic(
  payload: RacePayload,
  cfg: HandoffConfig,
): Promise<Handicap> {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const resp = await client.messages.create({
    model: cfg.anthropicModel,
    max_tokens: 2048,
    system: cfg.persona,
    tools: [
      {
        name: "submit_handicap",
        description: "Submit the structured handicap for this race.",
        input_schema: HANDICAP_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: "submit_handicap" },
    messages: [{ role: "user", content: buildUserMessage(payload) }],
  });
  const toolUse = resp.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Anthropic did not return a tool_use block");
  }
  return handicapSchema.parse(toolUse.input);
}

// ── Poe (OpenAI-compatible) ─────────────────────────────────────────────────
async function callPoe(payload: RacePayload, cfg: HandoffConfig): Promise<Handicap> {
  const resp = await fetch("https://api.poe.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.poeApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.poeModel,
      messages: [
        { role: "system", content: cfg.persona },
        { role: "user", content: buildUserMessage(payload) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "handicap", schema: HANDICAP_JSON_SCHEMA, strict: true },
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Poe HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Poe returned no content");
  return handicapSchema.parse(JSON.parse(content));
}

// Run the handicap for a single race through the configured provider.
export async function handicapRace(
  payload: RacePayload,
  cfg: HandoffConfig,
): Promise<{ handicap: Handicap; provider: LlmProvider; model: string }> {
  if (cfg.provider === "poe") {
    if (!cfg.poeApiKey) throw new Error("Poe API key not configured");
    return { handicap: await callPoe(payload, cfg), provider: "poe", model: cfg.poeModel };
  }
  if (!cfg.anthropicApiKey) throw new Error("Anthropic API key not configured");
  return {
    handicap: await callAnthropic(payload, cfg),
    provider: "anthropic",
    model: cfg.anthropicModel,
  };
}
