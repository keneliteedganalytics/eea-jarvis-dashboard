// Anthropic-generated 2-3 sentence betting-angle summary for a single race,
// used by the printable picks page. Reuses the active persona as the system
// prompt but constrains the model to plain prose. Cached in race_summaries
// per (raceId, eea_version); the cache is invalidated when the active formula
// version changes.

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { PERSONA_V1 } from "./eea-config";
import type { Race } from "@shared/schema";

const SUMMARY_INSTRUCTION =
  "In 2-3 sentences, explain the betting angle for this race. Focus on why the top pick has the edge and what the key risk is. Plain prose, no bullet points, no headings.";

function resolveAnthropicConfig(): { apiKey: string; model: string; persona: string } {
  const s = storage.getSettings();
  const apiKey = process.env.ANTHROPIC_API_KEY || s.anthropicApiKey || "";
  const model = s.defaultAnthropicModel || process.env.DEFAULT_ANTHROPIC_MODEL || "claude-sonnet-4-5";
  const persona = storage.getActiveFormulaVersion()?.personaText || PERSONA_V1;
  return { apiKey, model, persona };
}

// Build the compact race payload the summary model sees.
function buildRaceContext(race: Race): string {
  const picks = [
    race.winPgm && `1) #${race.winPgm} ${race.winName} (EEA ${race.winScore ?? "—"})`,
    race.placePgm && `2) #${race.placePgm} ${race.placeName} (EEA ${race.placeScore ?? "—"})`,
    race.showPgm && `3) #${race.showPgm} ${race.showName} (EEA ${race.showScore ?? "—"})`,
    race.fourthPgm && `4) #${race.fourthPgm} ${race.fourthName} (EEA ${race.fourthScore ?? "—"})`,
  ].filter(Boolean);
  const flags = JSON.parse(race.flags || "[]") as string[];
  const lines = [
    `<race_data>`,
    `Race ${race.raceNumber} — ${race.conditions ?? ""}`,
    race.shape ? `Projected shape: ${race.shape}` : "",
    race.read ? `Analyst read: ${race.read}` : "",
    `Tier: ${race.tier}`,
    `Top 4 (rank order):`,
    ...picks,
    flags.length ? `Flags: ${flags.join(", ")}` : "",
    `</race_data>`,
    "",
    SUMMARY_INSTRUCTION,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

// Returns the cached summary if present + still on the active eea version,
// otherwise generates a fresh one via Anthropic and caches it.
export async function getOrGenerateRaceSummary(race: Race): Promise<string> {
  const activeVersion = storage.getActiveFormulaVersion()?.id ?? null;
  const cached = storage.getRaceSummary(race.id);
  if (cached && cached.eeaVersion === activeVersion) {
    return cached.summary;
  }

  const { apiKey, model, persona } = resolveAnthropicConfig();
  if (!apiKey) {
    throw new Error("Anthropic API key not configured (set ANTHROPIC_API_KEY or save it in Settings)");
  }

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    system: persona,
    messages: [{ role: "user", content: buildRaceContext(race) }],
  });
  const summary = resp.content
    .filter((c) => c.type === "text")
    .map((c) => (c.type === "text" ? c.text : ""))
    .join(" ")
    .trim();
  if (!summary) throw new Error("Anthropic returned an empty summary");

  storage.upsertRaceSummary({
    raceId: race.id,
    summary,
    eeaVersion: activeVersion,
    generatedAt: new Date(),
  });
  return summary;
}
