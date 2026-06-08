/**
 * Seed / refresh / extend the EEA Jarvis TTS pronunciation dictionary.
 *
 * The dictionary lives in server/data/pronunciation_overrides.json and is the
 * single source of truth for both the uploaded ElevenLabs Pronunciation
 * Dictionary and the SSML phoneme fallback (see server/services/pronunciation.ts).
 *
 * Usage:
 *   # Re-upload the current JSON to ElevenLabs (returns a fresh dictionary id):
 *   npx tsx script/seed_pronunciation_overrides.ts
 *
 *   # List every override currently in the dictionary:
 *   npx tsx script/seed_pronunciation_overrides.ts --list
 *
 *   # Add a phoneme override (IPA) WITHOUT a redeploy, then auto re-upload:
 *   npx tsx script/seed_pronunciation_overrides.ts --add grapheme="Monmouth" phoneme="ˈmɑnməθ"
 *
 *   # Add an alias (plain respelling) override:
 *   npx tsx script/seed_pronunciation_overrides.ts --add grapheme="Woodbine" alias="Wood Bine"
 *
 *   # Add but skip the re-upload (just edit the file):
 *   npx tsx script/seed_pronunciation_overrides.ts --add grapheme="Penn" alias="Pen" --no-upload
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildPlsLexicon,
  getDictionaryLocator,
  loadPronunciationEntries,
  _resetDictionaryCache,
  type PronunciationEntry,
} from "../server/services/pronunciation";

const DICT_PATH =
  process.env.PRONUNCIATION_OVERRIDES_PATH ||
  path.join(process.cwd(), "server", "data", "pronunciation_overrides.json");

function parseAddFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^(\w+)=(.*)$/s);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function readDictFile(): { _meta?: unknown; entries: PronunciationEntry[] } {
  const raw = fs.readFileSync(DICT_PATH, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    const entries = loadPronunciationEntries();
    console.log(`${entries.length} pronunciation override(s) in ${DICT_PATH}:\n`);
    for (const e of entries) {
      console.log(`  ${e.grapheme.padEnd(28)} → ${e.phoneme ? `[${e.alphabet ?? "ipa"}] ${e.phoneme}` : `alias "${e.alias}"`}`);
    }
    return;
  }

  if (args.includes("--add")) {
    const addArgs = args.slice(args.indexOf("--add") + 1);
    const fields = parseAddFlags(addArgs);
    if (!fields.grapheme || (!fields.phoneme && !fields.alias)) {
      console.error('--add requires grapheme="…" and one of phoneme="…" or alias="…"');
      process.exit(1);
    }
    const dict = readDictFile();
    dict.entries = Array.isArray(dict.entries) ? dict.entries : [];
    const idx = dict.entries.findIndex((e) => e.grapheme.toLowerCase() === fields.grapheme.toLowerCase());
    const entry: PronunciationEntry = fields.phoneme
      ? { grapheme: fields.grapheme, alphabet: (fields.alphabet as "ipa" | "cmu") || "ipa", phoneme: fields.phoneme }
      : { grapheme: fields.grapheme, alias: fields.alias };
    if (idx >= 0) dict.entries[idx] = entry;
    else dict.entries.push(entry);
    fs.writeFileSync(DICT_PATH, JSON.stringify(dict, null, 2) + "\n");
    console.log(`${idx >= 0 ? "Updated" : "Added"} override for "${fields.grapheme}".`);

    if (args.includes("--no-upload")) {
      console.log("Skipping ElevenLabs re-upload (--no-upload). The running server will pick up the file on next restart.");
      return;
    }
  }

  // Default action (and tail of --add): build + upload the dictionary.
  const entries = loadPronunciationEntries();
  if (entries.length === 0) {
    console.error(`No usable entries found in ${DICT_PATH}.`);
    process.exit(1);
  }
  const pls = buildPlsLexicon(entries);
  console.log(`Built PLS lexicon with ${entries.length} entries (${pls.length} bytes).`);

  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn("ELEVENLABS_API_KEY not set — cannot upload. The SSML fallback will still apply at runtime.");
    return;
  }

  _resetDictionaryCache();
  const locator = await getDictionaryLocator();
  if (!locator) {
    console.error("Upload failed. Runtime will fall back to SSML phoneme injection.");
    process.exit(1);
  }
  console.log(`Uploaded. dictionary_id=${locator.pronunciation_dictionary_id} version_id=${locator.version_id}`);
  console.log("Set ELEVENLABS_PRONUNCIATION_DICTIONARY_ID in env to pin this version across restarts (optional).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
