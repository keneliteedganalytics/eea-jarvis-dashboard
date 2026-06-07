# Elite Edge Analytics — Jarvis Dashboard

A full handicapping operations platform: daily card overview, per-race deep-dives, results entry with auto-grading, performance analytics, and a Jarvis-style voice walkthrough powered by ElevenLabs TTS.

Stack: Next.js-style Vite + React + Tailwind frontend, Express + SQLite backend, ElevenLabs voice integration, server-sent events for live updates.

---

## What's inside

- **Today's Card** — Upload a Brisnet + Equibase PDF pair, the v1 engine parses, fuses, and tiers every race (SNIPER / EDGE / DUAL / RECON / PASS); top-line stats and a BRIEF ME voice walkthrough.
- **Race Detail** — Top 4 picks (Win/Place/Show/4th) with editable Why & Pace notes, pace shape diagram, suggested wagers by tier, BRIEF THIS RACE voice button.
- **Print Picks** — One-click printer-friendly daily sheet: one page per card, each race a clean block with its top 4, tier, recommended bets (WIN/PLACE/SHOW + EXACTA/TRIFECTA/SUPERFECTA sized to your bankroll), and a 2–3 sentence Anthropic race summary.
- **Results** — Punch in final order, hit Grade, scorecard updates live and Jarvis auto-recaps the race over speakers via SSE. An auto-fetch poller backfills finals for locked cards.
- **Analytics** — KPI cards + 4 Recharts (tier hit rate, ROI/bankroll curve, flag accuracy, race-type performance).
- **Settings** — Bankroll, daily risk cap, per-tier wager amounts, Anthropic/Poe LLM provider + model, voice picker (8 ElevenLabs premades + your full account voice list), model + speed slider, Test Voice.

Seed data includes Saratoga June 7 2026 (11 races, 4 picks each, R1 pre-graded as a worked example).

### The v1 handicapping engine

Upload a Brisnet PP PDF and the matching Equibase PDF on the home page. The engine parses both, fuses the data sources, runs the EEA scoring formula, assigns a conviction tier per race, and hands the structured card to an LLM (Anthropic by default, Poe optional) for the analyst read. You review and edit on the confirm screen, then publish. Set `ANTHROPIC_API_KEY` (or `POE_API_KEY`) in `.env` or under Settings — env takes precedence.

---

## Prerequisites

- **Node.js 20+** — Download from https://nodejs.org if you don't have it.
- **An ElevenLabs API key** — Already in your records (Pro tier).

Verify Node is installed:
```bash
node --version    # should print v20.x.x or higher
npm --version
```

---

## First-time setup (5 minutes)

```bash
# 1. Unzip this package somewhere you'll remember
cd ~/Desktop        # or wherever
unzip eea-jarvis-dashboard.zip
cd eea-dashboard

# 2. Install dependencies (this takes ~2 min the first time)
npm install

# 3. Set up your API keys
cp .env.example .env
# Open .env in any text editor and paste your keys after the =:
#   ELEVENLABS_API_KEY  — required for Jarvis voice
#   ANTHROPIC_API_KEY   — required for the v1 engine + print summaries
#                         (POE_API_KEY works as an alternative provider)

# 4. Build the production bundle
npm run build

# 5. Start the server
NODE_ENV=production node dist/index.cjs
```

You should see:
```
[poller] starting Equibase poller (60s interval)
serving on port 5000
```

Open **http://localhost:5000** in your browser. Done.

---

## Daily workflow

1. Open http://localhost:5000 — you'll see Today's Card with all 11 Saratoga races.
2. Upload a Brisnet + Equibase PDF pair in the drop zone to analyze a new card; review and publish on the confirm screen.
3. Hit **BRIEF ME** in the hero — Jarvis reads the full card overview.
4. Hit **Print Picks** to open the printer-friendly sheet (bets + Anthropic summaries) and send it to your printer.
5. Click any race row to see top-4 picks, pace shape, and wager suggestions.
6. After a race goes final, go to **Results**, type the order (e.g. `2,11,9,10`), hit **Grade** — or let the poller auto-fetch finals.
7. The scorecard updates live and you'll hear Jarvis recap the race automatically.
8. Check **Analytics** to see tier hit rates, ROI curve, flag accuracy over time.

Stop the server anytime with `Ctrl+C`. Your data persists in `data.db` in the project root.

---

## Adding new cards

Right now the system seeds the Saratoga 6/7/2026 card automatically. To add a new card:

**PDF auto-import (works today):**
Drop a Brisnet PP PDF and the matching Equibase PDF into the home-page drop zone. The v1 engine parses both, fuses the sources, scores and tiers every race, and runs the LLM analyst pass. Review the result on the confirm screen, edit any pick, then publish to make it the live card.

**Manual option:**
Edit `server/storage.ts` `seedSaratogaCard()` to define a card with races and picks, then delete `data.db` and restart to re-seed.

---

## Hosting on eliteedgeanalytics.com

You own the domain — here are the realistic paths to put this app behind it. **Important constraint:** this app is a full Node + Express + SQLite backend, not a static site. Your current cPanel/shared host probably won't run it. You need one of these:

### Option 1 — Run it on your computer, point a subdomain to your IP (zero monthly cost)
Best for: personal use, you're at your desk on race days.
1. Run `node dist/index.cjs` on your computer.
2. Set up port forwarding on your router (port 80 or 443 → your machine's port 5000).
3. In your DNS for eliteedgeanalytics.com, create an A record: `jarvis.eliteedgeanalytics.com` → your home IP.
4. Use a free DDNS service (no-ip.com, duckdns.org) if your IP changes.
5. Add a free SSL cert with Caddy or nginx + Let's Encrypt.

Trade-off: only works when your computer is on and connected. Best for solo use.

### Option 2 — VPS for ~$5/month (recommended for "always on")
Best for: you want jarvis.eliteedgeanalytics.com to work 24/7 from anywhere.

Hosts that work well for this stack: **Hetzner ($4/mo)**, **DigitalOcean ($6/mo)**, **Linode**, **Vultr**, **Railway ($5/mo)**.

Workflow:
1. Spin up a basic Ubuntu VPS.
2. Install Node 20 + nginx.
3. Upload this project, run `npm install && npm run build`.
4. Use `pm2` or `systemd` to keep `node dist/index.cjs` running.
5. nginx reverse-proxies port 80/443 → 5000.
6. Point `jarvis.eliteedgeanalytics.com` DNS A record to the VPS IP.
7. Let's Encrypt for HTTPS.

I can write you a one-shot setup script when you're ready.

### Option 3 — Railway / Render / Fly.io ($5–10/mo, simplest)
Best for: you don't want to manage a server.
1. Push this project to a private GitHub repo.
2. Connect Railway (or Render) to the repo — auto-detects Node, runs `npm run build` then `node dist/index.cjs`.
3. Add `ELEVENLABS_API_KEY` as an env var in the dashboard.
4. Point `jarvis.eliteedgeanalytics.com` CNAME → the Railway-provided host.

Trade-off: simplest. Pays for what you actually use. SQLite persists on Railway via a mounted volume (Render/Fly need a volume too).

### Option 4 — Vercel / Netlify (NOT recommended for this app)
These platforms are static-site + serverless function focused. SQLite doesn't work well there (no persistent file system between invocations). You'd need to migrate to Postgres/Supabase first. Doable, ~1 hour of work, but extra complexity.

---

## Security notes

This app has **no authentication** — anyone who hits the URL can write to your database and trigger TTS calls (which burn your ElevenLabs quota).

For local-only use (`http://localhost:5000`) this is fine.

Before exposing to the open internet, add a simple shared-secret header check. Easy options:
- **Basic auth via nginx** — `auth_basic_user_file` in the nginx config. One line per user.
- **Cloudflare Access** — free tier, email-based login in front of your domain.
- **App-level API key** — add a middleware in `server/routes.ts` that checks `req.headers["x-api-key"] === process.env.API_KEY` on all `/api/*` routes.

I can wire option 3 for you whenever — would take ~10 min.

---

## File layout

```
eea-dashboard/
├── client/                  # React + Tailwind frontend
│   └── src/
│       ├── pages/           # Home, Review, RaceDetail, Results, Analytics, Settings, Print
│       ├── print.css        # Ink-friendly @media print styles for the picks sheet
│       ├── components/      # AppLayout, JarvisPlayer, PickCell, UploadCard, brand/
│       └── lib/             # jarvis.tsx (TTS hook), tiers, wagers
├── server/                  # Express + SQLite backend
│   ├── routes.ts            # All API endpoints + seed + poller wiring
│   ├── storage.ts           # DatabaseStorage class + seedSaratogaCard()
│   ├── db.ts                # SQLite connection + CREATE TABLE statements
│   ├── grading.ts           # gradeRace() + gradeFlags()
│   ├── analytics.ts         # buildAnalyticsSummary() + buildCardStats()
│   └── services/
│       ├── tts.ts           # ElevenLabs proxy + audio cache
│       ├── scripts.ts       # Brief/recap script generators
│       ├── events.ts        # SSE event bus
│       ├── poller.ts        # results poller (auto-fetch finals for locked cards)
│       ├── analyze-card.ts  # v1 engine: parse → fuse → score → tier → LLM read
│       ├── bet-sizer.ts     # Print view: bankroll-aware bet sizing per tier
│       ├── race-summary.ts  # Print view: cached Anthropic race summaries
│       └── parsers/         # Brisnet + Equibase PDF parsers
├── shared/
│   └── schema.ts            # Drizzle table defs + Zod schemas
├── data.db                  # SQLite (created on first run)
├── audio_cache/             # ElevenLabs MP3 cache (created on first run)
├── package.json
└── README.md
```

---

## Updating your handicapping data

Currently the Saratoga card is hardcoded in `server/storage.ts` `seedSaratogaCard()`. To replace with a new track/day:

1. Open `server/storage.ts` in any editor.
2. Find the `seedSaratogaCard()` function near the bottom.
3. Update the `card` object (track, date) and the `races[]` array (race number, conditions, picks, flags).
4. Delete `data.db` so it re-seeds on next startup.
5. Restart: `node dist/index.cjs`.

A better path (next iteration): build a PDF parser so you drop the Quant-Capper or Brisnet PDF and it populates the database automatically. The visual drop zone is already on the home page — just needs the parser wired up.

---

## Troubleshooting

**"command not found: node"** — Install Node 20+ from https://nodejs.org.

**Port 5000 already in use** — Set `PORT=5001` in your `.env` and restart.

**ElevenLabs 401** — Your API key is wrong or expired. Verify at https://elevenlabs.io/app/settings/api-keys.

**No audio plays** — Check browser console. Some browsers block autoplay; click anywhere on the page first, then hit BRIEF ME.

**Database errors after editing seed data** — Delete `data.db` and restart to re-seed.

---

## What's NOT included yet (roadmap)

- **Payout-aware ROI** — results capture payout fields; the analytics ROI curve still uses flat units.
- **Multi-card UI polish** — the engine and storage are multi-card; the dashboard surfaces the latest card.
- **Authentication** — see Security Notes above. Required before public hosting.
- **Custom voice cloning** — your ElevenLabs Pro tier supports cloning. Pre-built UI to clone "your voice" or a track announcer voice is a 1-hour add.

---

Built by Elite Edge Analytics. Sniper-tier discipline only.
