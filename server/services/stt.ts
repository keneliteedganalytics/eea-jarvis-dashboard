// Speech-to-text via ElevenLabs Scribe. Ken has an ElevenLabs key (no OpenAI),
// so we reuse it for STT as well as TTS. Keyterm prompting is seeded with the
// horse + jockey names from the current card so names like "Tongue Twister" or
// "Aristide Maillol" transcribe cleanly instead of phonetic mush.

const SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
// Model id is overridable via env. Both scribe_v1 and scribe_v2 are valid;
// we stay on scribe_v1 to keep accuracy/billing behavior stable.
const SCRIBE_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";

// ElevenLabs Scribe rejects keywords over 50 chars (validation_error:
// invalid_keyword_length). Some card keyterms (full horse names with sire
// suffixes) exceed this, so we drop them rather than truncate.
const MAX_KEYWORD_LEN = 50;

export interface TranscribeOptions {
  keyterms?: string[];
  mimeType?: string;
}

// Transcribe a recorded audio blob. `audio` is the raw bytes captured by the
// browser's MediaRecorder (webm/opus by default).
export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions = {},
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
  if (!audio?.length) throw new Error("No audio provided");

  const form = new FormData();
  const mime = opts.mimeType || "audio/webm";
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("wav") ? "wav" : "webm";
  // Node 18+ exposes Blob/FormData globally; FormData files need a Blob.
  form.append("file", new Blob([audio], { type: mime }), `clip.${ext}`);
  form.append("model_id", SCRIBE_MODEL);
  form.append("tag_audio_events", "false");

  // Keyterm prompting: bias the recognizer toward the card's proper nouns.
  // Cap the list so the prompt stays small; dedupe is the caller's job.
  // ElevenLabs wants the param named "keywords" with each term as its own
  // repeated form field — NOT one JSON-stringified blob.
  const raw = (opts.keyterms || []).slice(0, 100);
  const terms: string[] = [];
  let dropped = 0;
  for (const t of raw) {
    const term = (t || "").trim();
    if (!term) continue;
    if (term.length > MAX_KEYWORD_LEN) {
      dropped++;
      continue;
    }
    terms.push(term);
  }
  if (dropped) {
    console.debug(`[stt] dropped ${dropped} keyword(s) over ${MAX_KEYWORD_LEN} chars`);
  }
  for (const term of terms) {
    form.append("keywords", term);
  }

  const resp = await fetch(SCRIBE_ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs STT ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { text?: string };
  return (data.text || "").trim();
}
