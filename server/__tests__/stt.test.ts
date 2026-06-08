import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { transcribeAudio } from "../services/stt";

const AUDIO = Buffer.from("fake-audio-bytes");

function okResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ text }),
    text: async () => JSON.stringify({ text }),
  } as unknown as Response;
}

function errResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

// Pull the keyword form fields out of the FormData the function POSTed.
function keywordsFrom(form: FormData): string[] {
  return form.getAll("keywords").map((v) => String(v));
}

describe("transcribeAudio — ElevenLabs Scribe keyword handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    fetchMock = vi.fn().mockResolvedValue(okResponse("hello world"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function sentForm(): FormData {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return init.body as FormData;
  }

  it("uses 'keywords' (not 'keyterms') with one repeated field per keyword", async () => {
    await transcribeAudio(AUDIO, { keyterms: ["Tongue Twister", "Aristide", "Maillol"] });
    const form = sentForm();
    // Old buggy field name must be gone.
    expect(form.getAll("keyterms")).toHaveLength(0);
    // One repeated "keywords" entry per term — not a single JSON blob.
    expect(keywordsFrom(form)).toEqual(["Tongue Twister", "Aristide", "Maillol"]);
    for (const v of keywordsFrom(form)) {
      expect(() => JSON.parse(v)).toThrow();
    }
  });

  it("filters out keywords longer than 50 chars (after trimming)", async () => {
    const tooLong = "Tongue Twister (Kitten's Joy) - Sweet Tooth By A Country Mile"; // > 50
    expect(tooLong.length).toBeGreaterThan(50);
    const exactly50 = "x".repeat(50); // boundary: kept
    await transcribeAudio(AUDIO, { keyterms: ["Secretariat", tooLong, exactly50] });
    const kw = keywordsFrom(sentForm());
    expect(kw).toEqual(["Secretariat", exactly50]);
    expect(kw).not.toContain(tooLong);
  });

  it("trims whitespace and drops empty/blank keywords", async () => {
    await transcribeAudio(AUDIO, { keyterms: ["  Justify  ", "", "   ", "Zenyatta"] });
    expect(keywordsFrom(sentForm())).toEqual(["Justify", "Zenyatta"]);
  });

  it("caps the list at 100 entries", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `H${i}`);
    await transcribeAudio(AUDIO, { keyterms: many });
    expect(keywordsFrom(sentForm())).toHaveLength(100);
  });

  it("omits the keywords field entirely when the list is empty", async () => {
    await transcribeAudio(AUDIO, { keyterms: [] });
    expect(keywordsFrom(sentForm())).toHaveLength(0);
  });

  it("omits the keywords field when every keyword is filtered out", async () => {
    await transcribeAudio(AUDIO, { keyterms: ["", "   ", "y".repeat(51)] });
    expect(keywordsFrom(sentForm())).toHaveLength(0);
  });

  it("omits the keywords field when no keyterms are provided", async () => {
    await transcribeAudio(AUDIO, {});
    expect(keywordsFrom(sentForm())).toHaveLength(0);
  });

  it("returns the trimmed transcript on a 200 response", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("  the four horse looks live  "));
    const out = await transcribeAudio(AUDIO, { keyterms: ["Live"] });
    expect(out).toBe("the four horse looks live");
  });

  it("throws with the upstream error text on a non-OK response", async () => {
    const detail =
      '{"detail":{"type":"validation_error","message":"All keywords must be less than 50 characters.","param":"keywords"}}';
    fetchMock.mockResolvedValue(errResponse(400, detail));
    await expect(transcribeAudio(AUDIO, { keyterms: ["x"] })).rejects.toThrow(/ElevenLabs STT 400/);
    await expect(transcribeAudio(AUDIO, { keyterms: ["x"] })).rejects.toThrow(/All keywords must be less than 50/);
  });

  it("throws when no API key is set", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(transcribeAudio(AUDIO, {})).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when no audio is provided", async () => {
    await expect(transcribeAudio(Buffer.alloc(0), {})).rejects.toThrow(/No audio/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
