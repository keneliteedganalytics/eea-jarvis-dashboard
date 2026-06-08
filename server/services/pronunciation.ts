import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Pronunciation overrides for ElevenLabs TTS.
//
// EEA Jarvis mispronounces track names, racing terms, and surnames. This module
// fixes that with two layered mechanisms, picked at call time:
//
//   1. PRIMARY  — ElevenLabs Pronunciation Dictionaries API. On first use we
//      generate a .pls (PLS = W3C Pronunciation Lexicon) from the JSON below,
//      upload it once, and cache the returned { dictionary_id, version_id }.
//      generateSpeech() then attaches a `pronunciation_dictionary_locators`
//      entry to every request. No per-call text mangling.
//
//   2. FALLBACK — SSML phoneme injection. If the upload fails (offline, bad
//      key, SDK/endpoint drift), we wrap matched tokens in the input string in
//      <phoneme alphabet="ipa" ph="…"> tags so a single call still pronounces
//      keyterms correctly. Alias-only entries fall back to a plain text swap.
//
//   3. DEGRADE  — If the dictionary file is missing or malformed, every export
//      here is a no-op pass-through. TTS keeps working, just without overrides.
//
// The dictionary is data-driven and extensible WITHOUT a redeploy: edit
// server/data/pronunciation_overrides.json (or use the seed script's --add
// flag) and the next server start re-reads it; re-run the seed script to push
// a fresh version to ElevenLabs.
// ---------------------------------------------------------------------------

export interface PronunciationEntry {
  grapheme: string;
  alphabet?: "ipa" | "cmu";
  phoneme?: string;
  alias?: string;
}

export interface DictionaryLocator {
  pronunciation_dictionary_id: string;
  version_id: string;
}

// Resolved per-call (not memoized) so PRONUNCIATION_OVERRIDES_PATH can be
// pointed at a different file in tests / by ops without a process restart.
// In dev the source lives under server/data; the production build ships it to
// dist/data (the runtime image omits the server/ tree — see script/build.ts).
function dictPath(): string {
  if (process.env.PRONUNCIATION_OVERRIDES_PATH) return process.env.PRONUNCIATION_OVERRIDES_PATH;
  const candidates = [
    path.join(process.cwd(), "server", "data", "pronunciation_overrides.json"),
    path.join(process.cwd(), "dist", "data", "pronunciation_overrides.json"),
    path.join(process.cwd(), "data", "pronunciation_overrides.json"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

let uploadedLocator: DictionaryLocator | null = null;
let uploadAttempted = false;

// ── Load ──────────────────────────────────────────────────────────────────
// Returns [] on any failure so callers degrade gracefully.
export function loadPronunciationEntries(): PronunciationEntry[] {
  try {
    const raw = fs.readFileSync(dictPath(), "utf8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return (parsed.entries as PronunciationEntry[]).filter(
      (e) => e && typeof e.grapheme === "string" && (typeof e.phoneme === "string" || typeof e.alias === "string"),
    );
  } catch {
    return [];
  }
}

// ── PLS generation ──────────────────────────────────────────────────────────
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build a W3C PLS lexicon string from the entries. ElevenLabs accepts both
// <phoneme> (IPA/CMU) and <alias> rules inside a single lexicon.
export function buildPlsLexicon(entries: PronunciationEntry[]): string {
  const lines = entries.map((e) => {
    const grapheme = `    <grapheme>${xmlEscape(e.grapheme)}</grapheme>`;
    const rule = e.phoneme
      ? `    <phoneme>${xmlEscape(e.phoneme)}</phoneme>`
      : `    <alias>${xmlEscape(e.alias ?? "")}</alias>`;
    return `  <lexeme>\n${grapheme}\n${rule}\n  </lexeme>`;
  });
  // ElevenLabs requires a single alphabet per lexicon; IPA is the superset we
  // seed with. Alias rules ignore the alphabet attribute.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"`,
    `  alphabet="ipa" xml:lang="en-US">`,
    ...lines,
    `</lexicon>`,
    ``,
  ].join("\n");
}

// ── ElevenLabs upload (PRIMARY path) ─────────────────────────────────────────
// Uploads the PLS once per process and caches the locator. Returns null on any
// failure so the caller falls back to SSML. Set ELEVENLABS_DISABLE_DICTIONARY=1
// to skip the upload entirely (forces the SSML fallback — handy in tests/dev).
export async function getDictionaryLocator(): Promise<DictionaryLocator | null> {
  if (uploadedLocator) return uploadedLocator;
  if (uploadAttempted) return uploadedLocator; // already tried + failed this process
  uploadAttempted = true;

  if (process.env.ELEVENLABS_DISABLE_DICTIONARY === "1") return null;

  // Pinned dictionary: if an id/version is provided in env (e.g. uploaded once
  // via the seed script), use it directly and skip the per-process upload.
  const pinnedId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
  const pinnedVersion = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
  if (pinnedId && pinnedVersion) {
    uploadedLocator = { pronunciation_dictionary_id: pinnedId, version_id: pinnedVersion };
    return uploadedLocator;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const entries = loadPronunciationEntries();
  if (entries.length === 0) return null;

  try {
    const pls = buildPlsLexicon(entries);
    const form = new FormData();
    form.append(
      "file",
      new Blob([pls], { type: "application/octet-stream" }),
      "eea_pronunciation.pls",
    );
    form.append("name", "EEA Jarvis Keyterms");
    form.append("description", "Track names, racing terms, and surnames for EEA Jarvis TTS.");
    form.append("workspace_access", "admin");

    const res = await fetch(
      "https://api.elevenlabs.io/v1/pronunciation-dictionaries/add-from-file",
      { method: "POST", headers: { "xi-api-key": apiKey }, body: form },
    );
    if (!res.ok) {
      console.warn(`[pronunciation] dictionary upload failed (${res.status}); falling back to SSML`);
      return null;
    }
    const data = (await res.json()) as { id?: string; version_id?: string };
    if (!data?.id || !data?.version_id) return null;
    uploadedLocator = { pronunciation_dictionary_id: data.id, version_id: data.version_id };
    return uploadedLocator;
  } catch (e) {
    console.warn(`[pronunciation] dictionary upload error; falling back to SSML:`, (e as Error).message);
    return null;
  }
}

// ── SSML injection (FALLBACK path) ───────────────────────────────────────────
// Wraps matched tokens in <phoneme> tags (IPA) or swaps to an alias spelling.
// Whole-word, case-insensitive, longest-grapheme-first so multi-word tokens
// ("Del Mar") win over single words. Already-injected spans are skipped.
export function injectSsmlPhonemes(text: string, entries = loadPronunciationEntries()): string {
  if (!text || entries.length === 0) return text;

  const sorted = [...entries].sort((a, b) => b.grapheme.length - a.grapheme.length);
  let out = text;
  for (const e of sorted) {
    const pattern = new RegExp(`(?<![\\w>])(${escapeRegExp(e.grapheme)})(?![\\w<])`, "gi");
    if (e.phoneme) {
      const alphabet = e.alphabet === "cmu" ? "cmu-arpabet" : "ipa";
      out = out.replace(pattern, (m) => `<phoneme alphabet="${alphabet}" ph="${e.phoneme}">${m}</phoneme>`);
    } else if (e.alias) {
      out = out.replace(pattern, e.alias);
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Test/diagnostic hook: forget the cached upload so the next call re-uploads.
export function _resetDictionaryCache(): void {
  uploadedLocator = null;
  uploadAttempted = false;
}
