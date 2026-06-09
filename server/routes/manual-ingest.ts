// Manual PDF drop ingest route (PR #33).
//
//   POST /api/cards/manual-ingest  (multipart/form-data)
//     fields: track (string), raceDate (YYYY-MM-DD)
//     files:  brisnetPdf (required), equibasePdf (optional)
//
// Runs the manual-ingest service (writes the bytes, runs the analyze-card
// pipeline through the Brisnet glyph-cipher decoder, persists a draft card,
// fuses + tiers it). Idempotent on (track, raceDate). Sits behind the same
// global HTTP basic auth as the rest of /api in server/index.ts.

import { Router } from "express";
import multer from "multer";
import { runManualIngest } from "../services/manual-ingest";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

export function manualIngestRouter(): Router {
  const router = Router();

  router.post(
    "/manual-ingest",
    upload.fields([
      { name: "brisnetPdf", maxCount: 1 },
      { name: "equibasePdf", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const { track, raceDate } = req.body as { track?: string; raceDate?: string };
        if (!track || !raceDate) {
          return res.status(400).json({ error: "track + raceDate required" });
        }
        const files = req.files as
          | { brisnetPdf?: Express.Multer.File[]; equibasePdf?: Express.Multer.File[] }
          | undefined;
        const brisFile = files?.brisnetPdf?.[0];
        if (!brisFile) {
          return res.status(400).json({ error: "brisnetPdf is required" });
        }
        const eqFile = files?.equibasePdf?.[0];

        const result = await runManualIngest({
          track,
          raceDate,
          brisnetBuffer: brisFile.buffer,
          brisnetFilename: brisFile.originalname,
          equibaseBuffer: eqFile?.buffer ?? null,
          equibaseFilename: eqFile?.originalname,
        });

        if (!result.ok) {
          return res.status(400).json(result);
        }
        return res.json(result);
      } catch (e) {
        console.error("[manual-ingest] failed", e);
        return res.status(500).json({ error: (e as Error).message || "ingest failed" });
      }
    },
  );

  return router;
}
