-- Horse-level workout annotations. Two nullable JSON columns on `races`:
--   horse_annotations  — JSON object Record<pgm, string[]> of workout tags
--                        from {BULLET, GATE, SHARP, NO_WORK}
--   horse_workout_text — JSON object Record<pgm, string> of raw workout lines
-- Both nullable; older cards have neither. The runtime bootstrap in
-- server/db.ts performs the same idempotent ALTER so the columns are present
-- without a drizzle-kit push (mirrors how prior race columns shipped).
ALTER TABLE races ADD COLUMN horse_annotations TEXT;
ALTER TABLE races ADD COLUMN horse_workout_text TEXT;
