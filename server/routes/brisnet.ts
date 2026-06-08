// Brisnet DRM ingest admin routes (behind the global HTTP basic auth in index.ts).
//
//   POST /api/admin/brisnet/ingest  -> manual trigger.
//        body: { raceDate: "YYYY-MM-DD", trackCodes?: string[] }
//   GET  /api/admin/brisnet/status  -> last run + enabled tracks.

import { Router } from "express";
import { z } from "zod";
import { ingestForDate, readConfig } from "../services/brisnet-ingest";

// Parse "YYYY-MM-DD" into a local-midnight Date. Returns null on bad input.
function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

const ingestBody = z.object({
  raceDate: z.string(),
  trackCodes: z.array(z.string()).optional(),
});

export function brisnetAdminRouter(): Router {
  const router = Router();

  router.post("/ingest", async (req, res) => {
    const parsed = ingestBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "raceDate (YYYY-MM-DD) required" });
    }
    const date = parseIsoDate(parsed.data.raceDate);
    if (!date) {
      return res.status(400).json({ error: "raceDate must be YYYY-MM-DD" });
    }
    const result = await ingestForDate(date, parsed.data.trackCodes, "manual");
    const code = result.status === "error" ? 502 : 200;
    res.status(code).json(result);
  });

  router.get("/status", (_req, res) => {
    const cfg = readConfig();
    res.json({
      enabledTrackCodes: cfg.enabledTrackCodes,
      lastRun: cfg.lastRun,
      lastResults: cfg.lastResults,
    });
  });

  return router;
}
