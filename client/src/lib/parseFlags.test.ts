import { describe, it, expect } from "vitest";
import { parseFlags } from "./parseFlags";

describe("parseFlags", () => {
  it("parses a valid JSON string-array", () => {
    expect(parseFlags('["BULLET on #6","Trip note"]')).toEqual(["BULLET on #6", "Trip note"]);
  });

  it("returns [] for an empty string", () => {
    expect(parseFlags("")).toEqual([]);
    expect(parseFlags("   ")).toEqual([]);
  });

  it("splits legacy ' | '-separated plain text", () => {
    expect(parseFlags("BULLET on #7 | BULLET on #6")).toEqual(["BULLET on #7", "BULLET on #6"]);
  });

  it("splits legacy comma-separated plain text", () => {
    expect(parseFlags("BULLET on #7, BULLET on #6")).toEqual(["BULLET on #7", "BULLET on #6"]);
  });

  it("treats malformed JSON as plain text and splits it", () => {
    // The exact value that crashed the Thistledown render.
    expect(parseFlags("BULLET on #6")).toEqual(["BULLET on #6"]);
  });

  it("returns [] for null/undefined and other non-strings", () => {
    expect(parseFlags(null)).toEqual([]);
    expect(parseFlags(undefined)).toEqual([]);
    expect(parseFlags(42)).toEqual([]);
  });

  it("passes through an array, coercing members to strings", () => {
    expect(parseFlags(["a", "b"])).toEqual(["a", "b"]);
    expect(parseFlags([1, 2])).toEqual(["1", "2"]);
  });

  it("falls through to plain-text split when JSON parses to a non-array", () => {
    // Valid JSON but not an array → treated as an opaque single token, not [].
    expect(parseFlags("{}")).toEqual(["{}"]);
    expect(parseFlags("123")).toEqual(["123"]);
  });
});
