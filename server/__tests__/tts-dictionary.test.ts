import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Isolated throwaway SQLite file — must be set before importing db/storage/tts.
const TMP_DB = path.join(os.tmpdir(), `eea-tts-test-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;
process.env.AUDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eea-tts-audio-"));

const ORIG_KEY = process.env.ELEVENLABS_API_KEY;
const ORIG_DICT = process.env.PRONUNCIATION_OVERRIDES_PATH;
const ORIG_DISABLE = process.env.ELEVENLABS_DISABLE_DICTIONARY;

// Returns a stub fetch that captures the last TTS request body and returns a
// tiny fake mp3 payload so generateSpeech() completes without a network call.
function stubFetch() {
  const calls: { url: string; body: any }[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = ORIG_KEY;
  if (ORIG_DICT === undefined) delete process.env.PRONUNCIATION_OVERRIDES_PATH;
  else process.env.PRONUNCIATION_OVERRIDES_PATH = ORIG_DICT;
  if (ORIG_DISABLE === undefined) delete process.env.ELEVENLABS_DISABLE_DICTIONARY;
  else process.env.ELEVENLABS_DISABLE_DICTIONARY = ORIG_DISABLE;
});

describe("generateSpeech — pronunciation dictionary injection", () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    // Force the SSML fallback path (no real dictionary upload over the network).
    process.env.ELEVENLABS_DISABLE_DICTIONARY = "1";
  });

  it("injects SSML <phoneme> tags for keyterms into the TTS request body", async () => {
    const { _resetDictionaryCache } = await import("../services/pronunciation");
    _resetDictionaryCache();
    const { generateSpeech } = await import("../services/tts");
    const calls = stubFetch();

    await generateSpeech("Welcome to Saratoga", "voiceX", "eleven_turbo_v2_5", 1.0);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toContain('<phoneme alphabet="ipa"');
    expect(calls[0].body.text).toContain(">Saratoga</phoneme>");
    // SSML fallback path → no locator attached.
    expect(calls[0].body.pronunciation_dictionary_locators).toBeUndefined();
  });

  it("gracefully degrades to plain text when the dictionary file is missing", async () => {
    process.env.PRONUNCIATION_OVERRIDES_PATH = "/nonexistent/overrides.json";
    const { _resetDictionaryCache } = await import("../services/pronunciation");
    _resetDictionaryCache();
    const { generateSpeech } = await import("../services/tts");
    const calls = stubFetch();

    await generateSpeech("Welcome to Saratoga", "voiceY", "eleven_turbo_v2_5", 1.0);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).not.toContain("<phoneme");
    // sanitizeForTTS still runs, so the keyterm survives as plain text.
    expect(calls[0].body.text).toContain("Saratoga");
  });
});
