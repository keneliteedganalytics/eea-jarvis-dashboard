# EEA Jarvis Dashboard — Project Rules for Claude Code

You are working inside `~/Desktop/eea-jarvis-dashboard` on a Mac for Kenneth Young
(ken@elite-edge-analytics.com). This is the Elite Edge Analytics horse racing
handicapping dashboard. The repo is also worked on remotely by a Perplexity
Computer agent, so the master branch may get new commits at any time.

## The user's hard rules

- **"I don't want to do anything manual."** When the user asks you to do
  something operational (pull, restart, flush, test, deploy), execute the
  commands yourself in the terminal. Do not paste commands for them to run.
- **"I don't want the format, layout, or look to change but it needs to be
  sharp."** When making UI changes, default to sharpness/polish — antialiasing,
  tabular numbers, tighter borders, font weights. Do NOT restructure layout
  or change the color palette unless explicitly asked.
- **Persona**: Treat the user as an expert, professional horseplayer. Skip
  beginner explanations.

## Standard commands (run these without asking)

**Pull and restart dev server** (most common — when user says "pull and restart"
or "pull the latest"):
```bash
lsof -ti :5050 | xargs kill -9 2>/dev/null
cd ~/Desktop/eea-jarvis-dashboard
git pull origin master
npm run dev
```

**Flush audio cache** (when TTS changes — user says "flush audio" or "clear cache"):
```bash
cd ~/Desktop/eea-jarvis-dashboard
sqlite3 database.db "DELETE FROM audio_cache;" 2>/dev/null
rm -f server/audio_cache/*.mp3
```

**Full reset** (port kill + pull + flush + restart — user says "full reset"):
```bash
lsof -ti :5050 | xargs kill -9 2>/dev/null
cd ~/Desktop/eea-jarvis-dashboard
git pull origin master
sqlite3 database.db "DELETE FROM audio_cache;" 2>/dev/null
rm -f server/audio_cache/*.mp3
npm install
npm run dev
```

**Check status**:
```bash
cd ~/Desktop/eea-jarvis-dashboard
git status
git log --oneline -5
lsof -i :5050
```

**Run a specific PR branch locally** (user says "check out PR N" or pastes a
branch name):
```bash
cd ~/Desktop/eea-jarvis-dashboard
lsof -ti :5050 | xargs kill -9 2>/dev/null
git fetch origin
git checkout <branch-or-pr-ref>
npm install
npm run dev
```

## Environment

- Node v22.22.3 via nvm
- Dev port: **5050** (set in `.env` as `PORT=5050`)
- `.env` lives at repo root and contains: `ELEVENLABS_API_KEY`,
  `ANTHROPIC_API_KEY`, `POE_API_KEY`, `PORT=5050`
- `.env` is gitignored. Never commit it. If you ever see API keys in a diff,
  STOP and tell the user before staging.
- The dashboard uses SQLite (`database.db` at repo root). Don't delete the
  whole DB — only the `audio_cache` table when flushing.

## Stack

- Express + Vite + React + Tailwind + shadcn/ui + Drizzle ORM + SQLite
- TypeScript everywhere
- `client/` is the React frontend, `server/` is the Express backend,
  `shared/schema.ts` is the Drizzle schema shared between them
- TTS: ElevenLabs via `server/services/tts.ts` (has heavy sanitizer — money,
  distances, odds, race conditions)
- LLM handoff: Anthropic primary + Poe fallback via `server/services/llm-handoff.ts`
- Handicapping engine: `server/services/eea-fusion.ts` + `server/services/analyze-card.ts`
- Data fetcher: `server/services/equibase.ts` (HorseRacingNation scraper)

## Tiers

The dashboard uses these tiers in order: **SNIPER > EDGE > DUAL > RECON > PASS**.
SNIPER is highest confidence, PASS means don't bet. Tier sizing is a % of the
daily bankroll risk cap, configured in Settings.

## Git workflow

- Public repo: `https://github.com/keneliteedganalytics/eea-jarvis-dashboard`
- Default branch: `master`
- Commit author: `Kenneth Young <ken@elite-edge-analytics.com>` (already
  configured)
- Feature work goes on `feat/*` branches, PR'd into master
- Conventional commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, scoped
  like `feat(ui):`, `fix(tts):`, `feat(print):`

## When in doubt

- If the user asks for something operational and you can execute it: just do it.
- If the user asks for code changes that could affect layout/look: confirm first,
  then make the smallest change that satisfies the request.
- If you see a TODO or follow-up in a recent commit message that you can knock
  out in <5 min, mention it but don't do it without asking.
- If a command fails or produces unexpected output: surface the actual error,
  don't paper over it.
