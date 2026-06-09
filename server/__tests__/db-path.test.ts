import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// db.ts opens a SQLite handle at import time, so point it at a throwaway file
// before importing the module under test.
const TMP_DB = path.join(os.tmpdir(), `eea-dbpath-${Date.now()}.db`);
process.env.DATABASE_FILE = TMP_DB;

import { resolveDbPath } from "../db";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDbPath (PR #30 persistence fix)", () => {
  it("honors DATABASE_FILE verbatim when set", () => {
    expect(resolveDbPath({ DATABASE_FILE: "/data/data.db" } as NodeJS.ProcessEnv)).toBe(
      "/data/data.db",
    );
    expect(resolveDbPath({ DATABASE_FILE: "/custom/x.db" } as NodeJS.ProcessEnv)).toBe(
      "/custom/x.db",
    );
  });

  it("defaults to /data/data.db when env is unset and /data exists (Railway)", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    expect(resolveDbPath({} as NodeJS.ProcessEnv)).toBe("/data/data.db");
    expect(spy).toHaveBeenCalledWith("/data");
  });

  it("falls back to ./data.db when /data does not exist (local dev)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(resolveDbPath({} as NodeJS.ProcessEnv)).toBe("./data.db");
  });

  it("never returns the bare relative 'data.db' that wiped the volume", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    expect(resolveDbPath({} as NodeJS.ProcessEnv)).not.toBe("data.db");
  });
});

describe("RAILWAY_DEPLOYMENT.md documents the persistence fix", () => {
  const doc = fs.readFileSync(
    path.join(__dirname, "..", "..", "RAILWAY_DEPLOYMENT.md"),
    "utf8",
  );

  it("mentions DATABASE_FILE=/data/data.db", () => {
    expect(doc).toContain("DATABASE_FILE=/data/data.db");
  });

  it("lists the ingest credential env vars", () => {
    expect(doc).toContain("BRISNET_USER");
    expect(doc).toContain("BRISNET_PASS");
    expect(doc).toContain("EQUIBASE_USER");
    expect(doc).toContain("EQUIBASE_PASS");
    expect(doc).toContain("OPENWEATHER_API_KEY");
  });
});
