// Daily expert-picks fetch.
//
// POSTs today's date + the six tracked tracks to /api/expert-picks/fetch on the
// running dashboard, which runs the scrapers and upserts the results. The
// scheduling itself is handled OUTSIDE the app (cron/launchd) — this script is a
// single shot: exit 0 on success, 1 on failure.
//
// Usage:  npx tsx scripts/fetch_expert_picks_daily.ts [YYYY-MM-DD]
// Env:    BASE_URL   (default http://localhost:5050)
//         ADMIN_PIN  (default 5811)

const TRACKS = [
  "belmont",
  "charles_town",
  "churchill_downs",
  "penn_national",
  "thistledown",
  "assiniboia_downs",
];

function todayInBoise(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

async function main() {
  const date = process.argv[2] || todayInBoise();
  const baseUrl = process.env.BASE_URL || "http://localhost:5050";
  const adminPin = process.env.ADMIN_PIN || "5811";

  const res = await fetch(`${baseUrl}/api/expert-picks/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-pin": adminPin,
    },
    body: JSON.stringify({ date, tracks: TRACKS }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`fetch failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }

  const body = (await res.json()) as {
    fetched: number;
    inserted: number;
    updated: number;
    failures: { source: string; track: string; error: string }[];
  };

  const sources = new Set<string>();
  // Count distinct sources that returned at least something by subtracting
  // failures from the attempted set isn't exact, so just report the failures.
  for (const f of body.failures) sources.add(f.source);

  console.log(
    `Fetched ${body.fetched} picks (inserted ${body.inserted}, updated ${body.updated}) for ${date}. ` +
      `Failures: ${JSON.stringify(body.failures)}`,
  );

  // Any failures are non-fatal for the day's run, but exit 1 if NOTHING landed.
  if (body.fetched === 0) {
    console.error("No picks fetched — treating as failure.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("fetch_expert_picks_daily crashed:", err);
  process.exit(1);
});
