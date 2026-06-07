import { db } from "../db";
import { cards, races, results, settings as settingsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "../storage";
import { fetchEquibaseResult } from "./equibase";
import { broadcastEvent } from "./events";

let pollInterval: NodeJS.Timeout | null = null;

// Parse a post time like "1:46 PM" on card date (YYYY-MM-DD) into a Date.
function postDate(post: string | null, date: string): Date | null {
  if (!post) return null;
  const m = post.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(y, mo - 1, d, hour, min);
}

function isPostPassed(post: string | null, date: string): boolean {
  const pd = postDate(post, date);
  if (!pd) return false;
  // Add a small buffer (2 min) after post for the chart to appear.
  return Date.now() > pd.getTime() + 2 * 60 * 1000;
}

async function pollLockedCards() {
  const settings = storage.getSettings();
  if (!settings.autoFetchEnabled) return;

  const lockedCards = db.select().from(cards).where(eq(cards.locked, true)).all();
  for (const card of lockedCards) {
    const cardRaces = db.select().from(races).where(eq(races.cardId, card.id)).all();
    for (const race of cardRaces) {
      const existing = db.select().from(results).where(eq(results.raceId, race.id)).get();
      if (existing) continue;
      if (!isPostPassed(race.post, card.date)) continue;

      const result = await fetchEquibaseResult(card.track, card.date, race.raceNumber);
      if (!result) {
        console.log(
          `[poller] Equibase parser pending — please use manual entry for race ${race.raceNumber}`,
        );
        continue;
      }

      // Persist + grade via storage (handles grading + flags).
      storage.logResult(race.id, result.finishOrder, {
        autoFetched: true,
        winPayout: result.winPayout,
        placePayout: result.placePayout,
        showPayout: result.showPayout,
        exactaPayout: result.exactaPayout,
        trifectaPayout: result.trifectaPayout,
        superfectaPayout: result.superfectaPayout,
      });

      broadcastEvent("race_result", {
        raceId: race.id,
        cardId: card.id,
        raceNumber: race.raceNumber,
        autoRecap: settings.autoRecapEnabled,
      });
    }
  }
}

export function startPoller() {
  if (pollInterval) return;
  const settings = storage.getSettings();
  const minutes = settings.fetchPollMinutes || 5;
  // Run once shortly after boot, then on interval.
  setTimeout(() => {
    pollLockedCards().catch((e) => console.error("[poller] error:", e));
  }, 10 * 1000);
  pollInterval = setInterval(() => {
    pollLockedCards().catch((e) => console.error("[poller] error:", e));
  }, minutes * 60 * 1000);
  console.log(`[poller] started — polling every ${minutes} min for locked cards`);
}
