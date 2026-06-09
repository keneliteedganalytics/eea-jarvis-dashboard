-- PR #42 — tier recalibration + PASS-WIN MISS tracking + conviction modifiers.
--
-- Tier weight recal (EDGE 18->25, DUAL 10->6) and the conviction modifiers
-- (ml_favorite_matched +5, speed_figure_gap demotion) and the Maiden Claim 9+
-- EX-only gate are code-level changes (server/services/budgeted-bets.ts and
-- server/services/fusion-v3.ts) plus the settings default tier_weights_json in
-- shared/schema.ts; they need no DDL.
--
-- This migration adds the only new persisted state: PASS-WIN MISS tracking on
-- card_summaries. A "miss" is a PASS race whose actual winner was on our board
-- grid (we rated it) but tiered PASS.
--
-- The project normally syncs schema with `drizzle-kit push` (npm run db:push);
-- this file is the explicit, reviewable forward migration for the same change.
-- SQLite has no JSONB, so the horses detail is stored as TEXT (JSON), matching
-- the rest of card_summaries.

ALTER TABLE card_summaries ADD COLUMN pass_win_miss_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE card_summaries ADD COLUMN pass_win_miss_horses TEXT NOT NULL DEFAULT '[]';

-- No backfill needed: only Card #4 (FL 2026-06-01) and Card #8 (FL 2026-06-09)
-- are graded. Re-running the grader (Mark Card Complete / re-grade routine)
-- recomputes their card_summaries rows under the recalibrated model and
-- populates these columns.

-- Move existing settings rows onto the recalibrated default weights so the live
-- allocator funds EDGE over DUAL immediately (only touches the PR #40 default
-- blob; any hand-customized weights are left as-is to respect user overrides).
UPDATE settings
SET tier_weights_json = '{"SNIPER":30,"EDGE":25,"DUAL":6,"RECON":4,"PASS":0}'
WHERE tier_weights_json = '{"SNIPER":30,"EDGE":18,"DUAL":10,"RECON":4,"PASS":0}';
