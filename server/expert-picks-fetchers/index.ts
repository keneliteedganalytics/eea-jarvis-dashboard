// Expert-picks orchestrator.
//
// fetchAllExpertPicks(date, tracks) runs the per-source fetchers, retrying each
// with exponential backoff, and returns the merged picks plus a per-source
// failure list. One source failing never aborts the others.
//
// Source routing per track key:
//   belmont          → Racing Dudes + NYRA/Serling   (two rows per race)
//   churchill_downs  → Racing Dudes + Churchill official
//   everything else  → Racing Dudes only

import type { ExpertPickInput } from "@shared/schema";
import { fetchRacingDudes } from "./racing-dudes";
import { fetchNyraSerling } from "./nyra-serling";
import { fetchChurchillOfficial } from "./churchill-official";

export interface FetchFailure {
  source: string;
  track: string;
  error: string;
}

export interface FetchAllResult {
  success: ExpertPickInput[];
  failures: FetchFailure[];
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000, 8000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a fetcher up to MAX_ATTEMPTS with exponential backoff. Throws the last
// error if every attempt fails.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}

interface Job {
  source: string;
  track: string;
  run: () => Promise<ExpertPickInput[]>;
}

function jobsForTrack(trackKey: string, date: string): Job[] {
  const jobs: Job[] = [
    {
      source: "racingdudes",
      track: trackKey,
      run: () => fetchRacingDudes(trackKey, date),
    },
  ];
  if (trackKey === "belmont") {
    jobs.push({
      source: "nyra_serling",
      track: trackKey,
      run: () => fetchNyraSerling(date),
    });
  }
  if (trackKey === "churchill_downs") {
    jobs.push({
      source: "churchill_official",
      track: trackKey,
      run: () => fetchChurchillOfficial(date),
    });
  }
  return jobs;
}

export async function fetchAllExpertPicks(
  date: string,
  tracks: string[],
): Promise<FetchAllResult> {
  const jobs = tracks.flatMap((t) => jobsForTrack(t, date));
  const success: ExpertPickInput[] = [];
  const failures: FetchFailure[] = [];

  type JobResult =
    | { ok: true; picks: ExpertPickInput[] }
    | { ok: false; job: Job; error: string };

  const results = await Promise.all<JobResult>(
    jobs.map(async (job) => {
      try {
        const picks = await withRetry(job.run);
        return { ok: true, picks };
      } catch (err) {
        return {
          ok: false,
          job,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const r of results) {
    if (r.ok) success.push(...r.picks);
    else
      failures.push({
        source: r.job.source,
        track: r.job.track,
        error: r.error,
      });
  }

  return { success, failures };
}
