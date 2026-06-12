// Seed the real_bets table from the Book Bets dump.
//
// Reads the canonical export at eea_analytics/book_bets.json (Ken's actual
// placed XBNet + Churchill book bets) and upserts each row by bet_id. Idempotent
// by design — re-running re-applies the same rows via ON CONFLICT DO UPDATE, so
// it's safe to run after every fresh export.
//
// Usage:  npx tsx scripts/seed_real_bets.ts [path/to/book_bets.json]

import { readFileSync } from "fs";
import { resolve } from "path";
import { storage } from "../server/storage";
import { realBetsBulkUpsertSchema, type RealBetInput } from "@shared/schema";

const DEFAULT_PATH = resolve(
  process.cwd(),
  "..",
  "eea_analytics",
  "book_bets.json",
);

interface RawBet {
  bet_id: string | number;
  placed_at: string;
  date: string;
  track: string;
  race: number;
  bet_type: string;
  bet_subtype?: string | null;
  wager_desc: string;
  base_amount?: number;
  total_cost: number;
  payout?: number;
  result: string;
  source: string;
}

function mapRow(r: RawBet): RealBetInput {
  return {
    betId: String(r.bet_id),
    placedAt: r.placed_at,
    date: r.date,
    track: r.track,
    race: r.race,
    betType: r.bet_type,
    betSubtype: r.bet_subtype ?? null,
    wagerDesc: r.wager_desc,
    baseAmount: r.base_amount ?? 0,
    totalCost: r.total_cost,
    payout: r.payout ?? 0,
    result: r.result as RealBetInput["result"],
    source: r.source,
  };
}

function main() {
  const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PATH;
  const raw = JSON.parse(readFileSync(file, "utf-8")) as RawBet[];
  if (!Array.isArray(raw)) {
    throw new Error(`Expected an array of bets in ${file}`);
  }
  const mapped = raw.map(mapRow);
  const { bets } = realBetsBulkUpsertSchema.parse({ bets: mapped });
  const { inserted, updated } = storage.bulkUpsertRealBets(bets);
  console.log(
    `Seeded real_bets from ${file}: ${bets.length} rows (${inserted} inserted, ${updated} updated).`,
  );
}

main();
