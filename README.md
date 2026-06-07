# Elite Edge Analytics — Jarvis Dashboard

A full handicapping operations platform: daily card overview, per-race deep-dives, results entry with auto-grading, performance analytics, and a Jarvis-style voice walkthrough powered by ElevenLabs TTS.

Stack: Next.js-style Vite + React + Tailwind frontend, Express + SQLite backend, ElevenLabs voice integration, server-sent events for live updates.

---

## What's inside

- **Today's Card** — Drop a PDF, see all races with conviction tier strips (SNIPER / EDGE / DUAL / RECON / PASS), top-line stats, BRIEF ME voice walkthrough button.
- **Race Detail** — Top 4 picks (Win/Place/Show/4th) with editable Why & Pace notes, pace shape diagram, suggested wagers by tier, BRIEF THIS RACE voice button.
- **Results** — Punch in final order, hit Grade, scorecard updates live and Jarvis auto-recaps the race over speakers via SSE.
- **Analytics** — KPI cards + 4 Recharts (tier hit rate, ROI/bankroll curve, flag accuracy, race-type performance).
- **Settings** — Bankroll, per-tier wager amounts, voice picker (8 ElevenLabs premades + your full account voice list), model + speed slider, Test Voice.

Seed data includes Saratoga June 7 2026 (11 races, 4 picks each, R1 pre-graded as a worked example).

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

# 3. Set up your ElevenLabs key
cp .env.example .env
# Open .env in any text editor and paste your key after the =

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
2. Hit **BRIEF ME** in the hero — Jarvis reads the full card overview.
3. Click any race row to see top-4 picks, pace shape, and wager suggestions.
4. After a race goes final, go to **Results**, type the order (e.g. `2,11,9,10`), hit **Grade**.
5. The scorecard updates live and you'll hear Jarvis recap the race automatically.
6. Check **Analytics** to see tier hit rates, ROI curve, flag accuracy over time.

Stop the server anytime with `Ctrl+C`. Your data persists in `data.db` in the project root.

---

## Adding new cards

Right now the system seeds the Saratoga 6/7/2026 card automatically. To add a new card:

**Manual option (works today):**
Use the Settings page → "Import card" (when wired) or edit `server/storage.ts` `seedSaratogaCard()` to define a new card with races and picks, then restart.

**PDF auto-import:**
The drop zone on the home page is a v1 visual stub. Drop a Quant-Capper PDF there in the next iteration to auto-parse into the database.

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
│       ├── pages/           # Home, RaceDetail, Results, Analytics, Settings
│       ├── components/      # AppLayout, JarvisPlayer, PickCell, brand/
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
│       ├── poller.ts        # 60s Equibase results poller
│       └── equibase.ts      # HTML parser (v1 stub — manual entry preferred)
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

- **PDF auto-import** — drop a Quant-Capper PDF, parse into the DB (visual stub exists).
- **Equibase auto-fetch** — infrastructure built; HTML parser stubbed. Manual results entry is the path for v1.
- **Multi-card support** — currently seeds one card. UI is already multi-card aware; just need an import flow.
- **Authentication** — see Security Notes above. Required before public hosting.
- **Custom voice cloning** — your ElevenLabs Pro tier supports cloning. Pre-built UI to clone "your voice" or a track announcer voice is a 1-hour add.

---

Built by Elite Edge Analytics. Sniper-tier discipline only.
