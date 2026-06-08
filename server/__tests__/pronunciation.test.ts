import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPronunciationEntries,
  buildPlsLexicon,
  injectSsmlPhonemes,
  getDictionaryLocator,
  _resetDictionaryCache,
  type PronunciationEntry,
} from "../services/pronunciation";

const ORIG_PATH = process.env.PRONUNCIATION_OVERRIDES_PATH;
const ORIG_KEY = process.env.ELEVENLABS_API_KEY;
const ORIG_DISABLE = process.env.ELEVENLABS_DISABLE_DICTIONARY;

function writeTempDict(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pron-")), "overrides.json");
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  if (ORIG_PATH === undefined) delete process.env.PRONUNCIATION_OVERRIDES_PATH;
  else process.env.PRONUNCIATION_OVERRIDES_PATH = ORIG_PATH;
  if (ORIG_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = ORIG_KEY;
  if (ORIG_DISABLE === undefined) delete process.env.ELEVENLABS_DISABLE_DICTIONARY;
  else process.env.ELEVENLABS_DISABLE_DICTIONARY = ORIG_DISABLE;
  _resetDictionaryCache();
});

describe("pronunciation dictionary — load", () => {
  it("loads the committed seed dictionary with known keyterms", () => {
    delete process.env.PRONUNCIATION_OVERRIDES_PATH; // use the real server/data file
    const entries = loadPronunciationEntries();
    expect(entries.length).toBeGreaterThan(0);
    const graphemes = entries.map((e) => e.grapheme.toLowerCase());
    expect(graphemes).toContain("saratoga");
    expect(graphemes).toContain("allowance");
  });

  it("filters out malformed entries (no phoneme and no alias)", () => {
    process.env.PRONUNCIATION_OVERRIDES_PATH = writeTempDict(
      JSON.stringify({
        entries: [
          { grapheme: "Good", phoneme: "ɡʊd" },
          { grapheme: "Bad" }, // dropped: no phoneme/alias
          { notAGrapheme: true }, // dropped
        ],
      }),
    );
    const entries = loadPronunciationEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].grapheme).toBe("Good");
  });
});

describe("pronunciation dictionary — graceful degradation", () => {
  it("returns [] when the dictionary file is missing", () => {
    process.env.PRONUNCIATION_OVERRIDES_PATH = "/nonexistent/path/overrides.json";
    expect(loadPronunciationEntries()).toEqual([]);
  });

  it("returns [] when the dictionary file is malformed JSON", () => {
    process.env.PRONUNCIATION_OVERRIDES_PATH = writeTempDict("{ not valid json ");
    expect(loadPronunciationEntries()).toEqual([]);
  });

  it("injectSsmlPhonemes is a pass-through when there are no entries", () => {
    const text = "Saratoga race 5 allowance";
    expect(injectSsmlPhonemes(text, [])).toBe(text);
  });

  it("getDictionaryLocator returns null (no upload) when API key is absent", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_DISABLE_DICTIONARY;
    _resetDictionaryCache();
    expect(await getDictionaryLocator()).toBeNull();
  });

  it("getDictionaryLocator returns null when explicitly disabled", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.ELEVENLABS_DISABLE_DICTIONARY = "1";
    _resetDictionaryCache();
    expect(await getDictionaryLocator()).toBeNull();
  });
});

describe("pronunciation dictionary — SSML injection (fallback path)", () => {
  const entries: PronunciationEntry[] = [
    { grapheme: "Saratoga", alphabet: "ipa", phoneme: "ˌsɛrəˈtoʊɡə" },
    { grapheme: "Del Mar", alias: "Dell Mar" },
  ];

  it("wraps a phoneme keyterm in an IPA <phoneme> tag", () => {
    const out = injectSsmlPhonemes("Welcome to Saratoga today", entries);
    expect(out).toContain('<phoneme alphabet="ipa" ph="ˌsɛrəˈtoʊɡə">Saratoga</phoneme>');
  });

  it("applies alias entries as a plain respelling", () => {
    const out = injectSsmlPhonemes("Racing at Del Mar", entries);
    expect(out).toContain("Dell Mar");
    expect(out).not.toContain("Del Mar");
  });

  it("is case-insensitive and preserves the matched casing inside the tag", () => {
    const out = injectSsmlPhonemes("the SARATOGA meet", entries);
    expect(out).toContain(">SARATOGA</phoneme>");
  });

  it("does not double-wrap an already-tagged span", () => {
    const once = injectSsmlPhonemes("Saratoga", entries);
    const twice = injectSsmlPhonemes(once, entries);
    expect(twice).toBe(once);
  });

  it("leaves non-keyterms untouched", () => {
    expect(injectSsmlPhonemes("just a normal sentence", entries)).toBe("just a normal sentence");
  });
});

describe("pronunciation dictionary — PLS generation", () => {
  it("emits a W3C lexicon with phoneme and alias rules", () => {
    const pls = buildPlsLexicon([
      { grapheme: "Saratoga", alphabet: "ipa", phoneme: "ˌsɛrəˈtoʊɡə" },
      { grapheme: "Del Mar", alias: "Dell Mar" },
    ]);
    expect(pls).toContain("<lexicon");
    expect(pls).toContain('alphabet="ipa"');
    expect(pls).toContain("<grapheme>Saratoga</grapheme>");
    expect(pls).toContain("<phoneme>ˌsɛrəˈtoʊɡə</phoneme>");
    expect(pls).toContain("<grapheme>Del Mar</grapheme>");
    expect(pls).toContain("<alias>Dell Mar</alias>");
  });

  it("XML-escapes special characters in graphemes", () => {
    const pls = buildPlsLexicon([{ grapheme: "A & B", alias: "A and B" }]);
    expect(pls).toContain("<grapheme>A &amp; B</grapheme>");
  });
});
