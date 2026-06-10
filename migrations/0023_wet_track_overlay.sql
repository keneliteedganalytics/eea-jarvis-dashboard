-- Wet-track overlay: per-race inferred/overridden track condition.
-- Nullable (backfilled null for existing rows); the runtime bootstrap in
-- server/db.ts performs the same idempotent ALTER so the column is present
-- without a separate drizzle-kit push.
ALTER TABLE races ADD COLUMN track_condition TEXT;
