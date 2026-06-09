# Deploying EEA Jarvis Dashboard to Railway

This is a one-shot setup guide. Once done, every `git push origin master`
auto-deploys to production in ~60 seconds. No further babysitting required.

**Target URL**: `https://jarvis.elite-edge-analytics.com`
**Cost**: ~$5/month (Railway Hobby plan)

---

## Prerequisites

- [x] GitHub account with this repo
- [x] Domain `elite-edge-analytics.com` registered (Squarespace Domains)
- [ ] Railway account (we'll create one)

---

## Step 1 — Create your Railway account (2 min)

1. Go to [railway.app](https://railway.app)
2. Click **Login** → **Login with GitHub**
3. Authorize Railway to read your GitHub repos
4. On the welcome screen, pick the **Hobby Plan** ($5/mo) when prompted
   (the free trial works too, but Hobby is what you want for a real site
   with a custom domain and persistent volume)

---

## Step 2 — Deploy the repo (3 min)

1. Click **+ New Project**
2. Pick **Deploy from GitHub repo**
3. Select **`keneliteedganalytics/eea-jarvis-dashboard`**
4. When asked which branch: pick **`master`**
5. Railway will detect `Dockerfile` + `railway.toml` and start building
   immediately. The first build takes ~3-5 minutes (subsequent builds
   are ~60s with cache).

While it builds, do steps 3 + 4 in parallel.

---

## Step 3 — Add a persistent volume (1 min)

This is what makes your SQLite database + audio cache survive restarts.

1. In the service page, click the **Settings** tab
2. Scroll to **Volumes** → click **+ Add Volume**
3. **Mount path**: `/data`
4. **Size**: 1 GB (plenty for now — you can grow it later)
5. Click **Add**

Railway will restart the service once when you attach the volume. Normal.

---

## Step 4 — Set environment variables (3 min)

In the service page, click the **Variables** tab → **+ New Variable** for
each one below. (Or use **Raw Editor** and paste all at once.)

> ⭐ **`DATABASE_FILE=/data/data.db` is NEWLY REQUIRED (PR #30).** Without it,
> the DB path defaults to a RELATIVE `data.db` that resolves to `/app/data.db`
> INSIDE the container image — outside the `/data` volume — so **every deploy
> wipes all saved cards.** It must point at the persistent `/data` mount.

```
NODE_ENV=production
PORT=5000

# ── Persistence (all under the /data volume) ──────────────────────────────
DATABASE_FILE=/data/data.db          # ⭐ NEWLY REQUIRED — see warning above
AUDIO_DIR=/data/audio_cache
UPLOAD_DIR=/data/uploads
EQUIBASE_PP_DIR=/data/equibase-pps   # downloaded Equibase PP/chart PDFs
BRISNET_DRM_DIR=/data/brisnet-drm    # downloaded Brisnet DRM zips

# ── Ingest credentials (live Brisnet + Equibase logins) ───────────────────
BRISNET_USER=Ken6741
BRISNET_PASS=Drewbaby11!             # note the trailing '!'
EQUIBASE_USER=Ken6741
EQUIBASE_PASS=Drewbaby11             # NO '!'

# ── API keys ──────────────────────────────────────────────────────────────
ELEVENLABS_API_KEY=<paste your real ElevenLabs key>
ANTHROPIC_API_KEY=<paste your real Anthropic key>
POE_API_KEY=<paste your real Poe key>
OPENWEATHER_API_KEY=<paste your real OpenWeather key>

# ── Basic auth (browser login prompt) ─────────────────────────────────────
BASIC_AUTH_USER=EliteEdgeAnalytics
BASIC_AUTH_PASS=Austin08
```

After saving, Railway redeploys. You should see the service go green within
60 seconds. Click **View Logs** to confirm:

- `[db] sqlite path=/data/data.db persisted=true writable=true`
- `[auth] HTTP basic auth ENABLED for user: EliteEdgeAnalytics`
- `serving on port 5000`

Click the generated `*.up.railway.app` URL to test. Browser will prompt for
the username/password — enter them and you should see the dashboard.

---

## Step 5 — Hook up your custom domain (5 min)

### 5a. In Railway

1. Service → **Settings** tab → **Networking** section
2. Click **+ Custom Domain**
3. Enter: `jarvis.elite-edge-analytics.com`
4. Railway shows you a **CNAME target** like `xyz123.up.railway.app`.
   **Copy that value.**

### 5b. In Squarespace Domains

1. Sign in at [domains.squarespace.com](https://domains.squarespace.com)
   with your `Ken@elite-edge-analytics.com` admin account
2. Click your domain `elite-edge-analytics.com`
3. Left sidebar → **DNS** (or "DNS Settings")
4. Scroll to **Custom Records** → click **Add Record**
5. Fill in:
   - **Host / Name**: `jarvis`
   - **Type**: `CNAME`
   - **Data / Value**: `<paste the xyz123.up.railway.app value from Railway>`
   - **TTL**: leave default (usually 4 hours / 14400)
6. **Save**

### 5c. Wait for DNS + SSL (~5–30 min)

- DNS propagates in 5–30 min usually (sometimes faster)
- Railway auto-issues a Let's Encrypt SSL cert once DNS resolves
- The custom domain row in Railway will turn **green** when ready

Once green, hit `https://jarvis.elite-edge-analytics.com` and you're done.
Bookmark it. Pull it up on any computer with the username/password.

---

## Updating the site

Whenever you (or Claude Code on your Mac) push to `master`:

```bash
git push origin master
```

Railway auto-builds and deploys in ~60 seconds. Zero clicks.

To see logs / deployment status: Railway dashboard → your service →
**Deployments** tab.

---

## Common ops

| Want to... | Where |
|---|---|
| Change the password | Variables tab → edit `BASIC_AUTH_PASS` → save |
| Rotate API keys | Variables tab → edit the key → save (auto-redeploys) |
| See live logs | Deployments tab → click latest → **View Logs** |
| Roll back a bad deploy | Deployments tab → older deploy → **Redeploy** |
| Connect SQLite to inspect | Settings → Volumes → connect via SSH (Railway docs) |
| Increase volume size | Settings → Volumes → edit size (data preserved) |

---

## Troubleshooting

**Build fails with `better-sqlite3` errors**
The Dockerfile installs `python3 make g++` in the builder stage to compile
the native module. If you change Node versions, rebuild fully (Settings →
Danger Zone → Redeploy without cache).

**Custom domain stuck on "Pending"**
DNS hasn't propagated yet. Wait 30 min then refresh. If still stuck after
24h, double-check the CNAME value in Squarespace matches what Railway shows.

**Browser keeps asking for password**
Either the username or password env var has a typo. Check Variables tab.
Note both are case-sensitive.

**Audio plays once then breaks after redeploy**
The volume isn't mounted. Settings → Volumes → confirm `/data` is attached
to this service. The Dockerfile chowns `/data` to the `node` user on first
boot.

**SQLite shows "database is locked"**
Only one Railway replica should run (default is 1). Don't scale this
service up — SQLite + multi-replica = corruption.

---

## Cost expectation

- Hobby plan: **$5/mo flat** includes $5 of usage
- This app typically uses ~$2-4/mo of compute on a single small instance
- Volume storage: included up to 5 GB on Hobby
- Custom domains: free
- Bandwidth: 100 GB/mo included

Realistically you'll stay inside the $5/mo flat fee.
