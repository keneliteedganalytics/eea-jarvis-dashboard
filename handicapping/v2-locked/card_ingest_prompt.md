# Elite Edge Analytics — Card Ingest Prompt v2
Last locked: 2026-06-12
Owner: Ken Young / Elite Edge Analytics

**This is the literal prompt I execute at the start of every card ingest. Read it before touching a PP or Brisnet doc. No skipping steps. No drift between sessions.**

---

## STRONGEST SIGNAL — Brisnet Prime Power (locked 2026-06-12)

**Backtest finding (Belmont 2026-06-11, 6 known winners):** Brisnet Prime Power top-rank, used naked, picked the winner in **5 of 6 races** (avg rank of winner under PP = 2.00). It beat the EEA composite, every weighted blend (PowSpd, PowSpdCls, PowSpdPace, AllFive, Bullring v2, Belmont/NYRA SNIPER), and the 14-model ensemble vote. Composite weighting was adding noise on top of an already-strong single signal.

**Rule: Prime Power is now the anchor for every race. Other factors only confirm or veto — they do not override.**

### PP-anchor decision tree (apply BEFORE any track-family rule)
1. Identify the PP top-rank horse (the #1 PP in the field).
2. **Veto checks** (any one fails → drop to PP #2, repeat):
   - `[NO WORK]` flag → veto. (Backtest: 0/11 NO_WORK horses won.)
   - PP gap to #2 is ≤ 1.0 AND the #2 horse has both higher Speed-last and higher Class rating → flag as **DUAL** (two-horse race), don't single.
3. **Confirmation boosters** (presence elevates tier; absence does not demote):
   - Top-2 Jockey win% in field → strongest confirmer (backtest avg rank of winner under jky% = 2.00; rescued the only PP miss in R8).
   - Top-3 Speed-avg3 OR Top-3 Class rating → secondary confirmers (both avg rank ≈ 3.2).
4. **Surface override (lone exception):** On turf routes 1M+, if PP #1 has never raced on turf AND PP #2 has top-2 turf Speed-life, flip to PP #2. (Belmont R8 1-1/16M turf was the only PP miss — #14 PP top-rank with thin turf record; #12 winner was 1st in jockey% and 4th in trainer%.)

### What is additive vs. noise (empirical, n=6 known winners)
| Factor | Avg rank of winner | Top-2 hit rate | Verdict |
|---|---|---|---|
| **Prime Power** | 2.00 | 5/6 | **Anchor** |
| **Jockey win%** | 2.00 | 5/6 | **Tiebreaker / rescue when PP gap < 1.0** |
| EEA composite score | 2.17 | 5/6 | Use as sanity check only — does not exceed naked PP |
| Speed avg3 | 3.17 | 2/6 | Weak — secondary confirmer at best |
| Class rating | 3.33 | 2/6 | Weak — secondary confirmer at best |
| Speed life | 3.67 | 3/6 | Weak |
| Trainer% | 3.83 | 1/6 | Weak |
| Speed last | 4.33 | 2/6 | Noise — actively misled in 4/6 races |
| JT combo% | 4.33 | 1/6 | Noise |
| Pace last/avg3/life | 4.7–5.3 | 1/6 | **Noise on routes — do not weight on 1M+ races** |

Note: Pace remains primary at bullring sprints (4½F–7F) per existing Bullring v2 rules. The noise verdict above is for routes (1M+).

### Workout flag effects (locked from Belmont backtest)
- `[NO WORK]` = **hard veto** (0/11 winners; never bet)
- `[BULLET]` = 12% hit rate (slightly above 9.5% base; weak positive)
- `[SHARP]` = 10% hit rate (at base; neutral)
- `[GATE]` = 0/4 winners in this sample; treat as neutral pending more data

---

## STEP 0 — Identify the source documents
- Brisnet PPs (PDF or screenshots): Basic, Advanced, Power, Speed, Pace, Lifetime, JT, Workouts
- Equibase PPs if present
- Local track expert / handicapper picks if present
- Confirm: did I receive the **Workouts** doc? If not, **flag the card and stop** — workouts are a hard gate. Ask Ken to upload before continuing.

## STEP 1 — Extract race header
For each race on the card, capture:
- Track, race number, post time
- Distance, surface (dirt/turf/AWS), condition (Fast/Good/Sloppy/Muddy/Firm/Yielding)
- Class (MCL/MSW/ALW/CLM/STK), purse, field size, age/sex restrictions

## STEP 2 — Select the track-family rule set
Match track to one of:

### Bullring family (Charles Town, Penn National, Mountaineer, Finger Lakes)
- **4½F**: rank by `(Pace Early + Pace End) / 2`. Race fits in ~53s — Pace End = the wire.
- **6F–7F**: Pace Early primary, Pace End tiebreaker.
- **SNIPER** = Power ≥ 75 AND (Pace Early ≥ 75 OR Pace End ≥ 75) AND bullet/gate/sharp work within 14d
- **EDGE** = Power ≥ 70 AND at least one pace figure ≥ 72
- **PASS** = no work in 14+ days OR Power < 60
- Default exotic: EXA Key chalk W/ ALL ($2 base) OR EXA Key W/ top-3 Pace Early

### Belmont / NYRA family (Belmont, Saratoga, Aqueduct — main + turf routes)
- Primary structure: **TRI Key SNIPER W/ 4 horses** at $3 base ($12 ticket)
- Pick 5 singles ONLY when SNIPER conviction in ≥ 2 of the 5 legs
- AVOID: EXA Straight bets, Win-only on horses > 8/1 in body of card
- **SNIPER** = PP rank #1 in field AND PP gap to #2 ≥ 2.0 AND top-2 Jockey% AND no [NO WORK] flag
- **EDGE** = PP rank #1 in field AND PP gap to #2 ≥ 1.0 (Jockey% confirmation not required)
- **DUAL** = PP gap to #2 ≤ 1.0 AND #2 has higher Speed-last OR higher Class
- **PASS** = PP < 65 OR [NO WORK] flag
- *Old composite thresholds (Power ≥ 85, top-2 Speed, T/J ≥ 18%) are retired — they hit 2/5 in backtest vs 4/5 for PP-anchor.*

### Other tracks (Churchill, Thistledown, Assiniboia, default)
- Pace Early + Power both primary
- **SNIPER** = Power ≥ 80 AND top-2 Speed AND qualifying work
- **EDGE** = Power ≥ 72
- **PASS** = no work in 14+ days OR Power < 60

## STEP 3 — Per-horse data pull
For every horse in the field, capture:
- Power Rating (Brisnet)
- Speed last race (Brisnet) — also note top speed in last 3
- Pace Early, Pace End
- Class rating
- Trainer win% (meet + 365d), Jockey win% (meet + 365d), T/J combo win%
- Workout signals — flag with:
  - `[BULLET]` top-ranked time at the work site/distance
  - `[GATE]` gate practice
  - `[SHARP]` strong recent drill (within 14d, not bullet)
  - `[NO WORK]` no work in 14+ days
- Equipment changes (blinkers on/off, lasix first time)
- Odds line if available

## STEP 4 — Tier each horse
Apply the track-family thresholds from STEP 2:
- **SNIPER** — top-of-card conviction
- **EDGE** — strong #1 candidate
- **DUAL** — two-horse race feel
- **RECON** — small win plays only
- **PASS** — skip, do not include in tickets

## STEP 5 — Cross-reference local expert picks
- Log local expert's top pick for the race in a separate column (do not weight)
- After the card runs, append actual result to expert-tracker file
- Comparison runs automatically (see expert-tracker workflow)

## STEP 6 — Build the output
For each race, produce:

### Executive Race Summary
1–2 sentences on pace shape, surface bias, class par.

### Top 4 Selections
Numbered list with tier, key fig, work flag, brief rationale.

### Betting Strategy
Pick the ticket structure from universal sizing rules:
- TRI Key W/ 4 = preferred. $3 base if SNIPER, $2 base if EDGE.
- EXA Box only with 3 horses ($12 at $2 base). Skip 2-horse EXA Box unless DUAL.
- Cap straight Win at $25 unless SNIPER.
- Daily Double / Pick 4 / Pick 5 — singles only when SNIPER in ≥ 2 legs.
- Exotics-first ALWAYS — "real money is on exactas, pick 4 dd etc"

## STEP 7 — Append legends to PDF output
```
Tiers: SNIPER (top-of-card) · EDGE (strong #1) · DUAL (two-horse) · RECON (small win) · PASS
Workouts: [BULLET] top-ranked time · [GATE] gate practice · [SHARP] strong recent drill · [NO WORK] no recent workout
```

## STEP 8 — Budget gate
- $1k daily risk budget per track
- $3k total bankroll cap per day
- If running total approaches cap, downgrade EDGE → RECON before placing more

## STEP 9 — Result capture
After each race:
- Log finishing order (1-2-3-4)
- Mark each pick: WIN / PLACE / SHOW / 4TH / OUT
- Update analytics DB via `/api/real-bets/bulk-upsert` (admin pin 5811)

---

## Hard rules (never override)
- Never bet a race where the Workouts doc is missing
- Never bet a horse with `[NO WORK]` flag (backtest: 0/11 NO_WORK winners)
- Never use words "scrape" or "crawl" in user-facing output
- Tier order: SNIPER > EDGE > DUAL > RECON > PASS
- All bets via book — book numbers are truth
- Auto-deploy clean PRs, nothing manual
- **PP-anchor first.** No multi-factor blend may override a PP #1 unless the surface-override clause fires (turf-route with no turf record + PP #2 turf-proven).

---

## LOCKED — Workout signal format on Jarvis (per Ken, 2026-06-12)

Anchored to the format used on Thistledown card #19 (2026-06-11). DO NOT DEVIATE.

### Source data
- Parse workouts from the **Equibase** PDF (not Brisnet) using `parse_workouts.py`.
- Equibase token: `<dd> <Mon> <yy> <trk> <distF>F <surf> <time> <Breezing|Handily> [g] <rank>/<field>`
- Flags per horse:
  - `bullet` = rank `1/N` within last 30 days
  - `gate` = trailing `g` within last 21 days
  - `sharp` = 3F<36 · 4F<49 · 5F<61 · 6F<74 within last 30 days
  - `no_work` = most recent workout ≥ 14 days ago

### `flags` JSON array on each race (sparse)
Contains ONLY headline 🔥 BULLET callouts, format:
```json
["BULLET on #4", "BULLET on #6"]
```
No SHARP, GATE, or NO_WORK chips. Non-workout existing flags pass through.

### `whyText` / Read line on each race (3 parts, in order)
1. **Lead**: `v2 PP-anchor: #<pgm> <Name> is the controlling pick — Brisnet Prime Power #1 at <pp> (gap <g>) [<anchor's glyph clause>]. <reason>.`
2. **Workout reads** (if any non-anchor top-4 pick has a signal):
   ` Workout reads — #<pgm> <Name> carries <glyphs>; ... .`
3. **Workout edge** (if any horse on the card has BULLET — every horse, not just top-4):
   ` Workout edge: 🔥 #<pgm> <Name> (<k> bullet[s]), ... .`

### Glyph vocabulary (matches Jarvis Home WORKOUT_LEGEND)
- 🔥 BULLET — top-ranked workout time
- ⏱️ SHARP — strong recent drill
- ⏱️ GATE — gate practice (same clock emoji as SHARP — yesterday used this)
- 📉 NO WORK — no recent workout edge

### Generator
`/home/user/workspace/cards_<date>/<track>/lock_yesterday_format.py` — DO NOT change without Ken's approval.

---

## LOCKED — Print PDF workflow (per Ken, 2026-06-12, 8:57 AM MDT)

The print bet-sheet PDF MUST be generated by rendering Jarvis's own `/print`
page with a headless browser. DO NOT use any custom ReportLab generator
(`build_pdf.py`, `build_v2_pdf.py`, etc.) — those produced ugly knockoffs
and broke the look-and-feel.

### Canonical generator
`/home/user/workspace/handicapping/print_card_from_jarvis.py`

Usage:
```
python3 /home/user/workspace/handicapping/print_card_from_jarvis.py [CARD_ID] [OUT_PATH]
```

Without arguments it prints the latest card to the standard
`cards_<date>/<track>/pdfs/<track>_<date>.pdf` location.

### Internals
1. Launches headless Chromium (Playwright) with HTTP Basic auth.
2. Loads `https://jarvis.elite-edge-analytics.com/#/print`.
3. Waits for the React `Print` component to mount (selector: "Race 1").
4. Emulates `media: print` so the page's own print CSS applies.
5. Calls `page.pdf()` Letter size, 0.4in margins, `printBackground: true`.

This produces the exact same PDF Ken gets when he hits Cmd-P on the Jarvis
print page in his browser.

### Do NOT
- Add custom ReportLab generators
- "Fix" the print page's read text by writing to whyText (Print uses `read`)
- Decorate `flags` chips with SHARP/GATE/NO_WORK — Print displays whatever
  is in `races.flags` verbatim as a "FLAGS" line

---

# 🔒 MASTER LOCK — v2 (per Ken, 2026-06-12, 9:16 AM MDT)

**The entire v2 pipeline below is LOCKED. Do NOT change, "improve", refactor,
or deviate from any step for any reason until Ken explicitly approves a v3.**

This lock covers:
1. Source ingestion (Brisnet, Equibase, OTB/TwinSpires last-minute drops)
2. v2 PP-anchor grading rules
3. Workout signal parsing + flag format
4. Jarvis card upload
5. Print PDF generation

If any step appears broken, **fix the bug without changing the contract**.
Never invent new formats, prose, generators, or rule tweaks.

---

## 1. Source ingestion — LOCKED

### Brisnet PDF
- Parser: `cards_<date>/<track>/parse_brisnet.py`
- Track-agnostic (matches "Ultimate PP's" header, not "Finger Lakes")
- Captures per-horse: Prime Power, pace_last/avg3/life, spd_last/avg3/life,
  class_rating, jky_pct, trn_pct, jt_pct, hot_trainer, hot_jockey,
  high_pct_*, no_work, drops_class, wnr_last, poor_record
- **Workout text is NOT parsed from Brisnet** (use Equibase — see §3)

### Equibase PDF
- Parser: `cards_<date>/<track>/parse_equibase.py`
- Supports up to 12 races, tolerant of 2yo MSW format with Sire/Dam stats
- Per-horse: pgm, post_pos, post_win_pct, horse, class_rating,
  pace_*, spd_*, jockey_trainer, jky_pct, trn_pct, jt_pct
- Workout block: parsed separately by `parse_workouts.py` (see §3)

### OTB / TwinSpires last-minute drops (scratches, rider changes, ML moves)
- Apply AFTER Brisnet+Equibase parse but BEFORE Jarvis upload
- Procedure:
  1. Pull current scratches/changes from OTB or TwinSpires
  2. For each scratched horse, mark scratched in `equibase.json` and
     `brisnet.json` (set a `scratched: true` field on the horse object)
  3. Re-evaluate v2 anchor selection skipping any `scratched: true` horse
  4. If anchor itself is scratched: promote next PP rank as new anchor,
     recompute gap, re-grade tier
  5. Record `scratchedPgms` on race for Jarvis (existing column)
- **Never silently drop a scratched horse from the data — always mark it.**

---

## 2. v2 PP-anchor grading rules — LOCKED

(Already in main doc above — restating LOCK condition.)

- Prime Power top-rank = anchor
- Jockey win% = confirmer/rescue
- [NO WORK] = hard veto (anchor demoted to next PP rank)
- Pace/Speed-last/JT% = noise on routes (informational only)
- Surface override for turf routes 1M+
- Tiers:
  - **SNIPER**: PP #1 + gap ≥ 2.0 + top-2 Jky% + no NO_WORK on anchor
  - **EDGE**: PP #1 + gap ≥ 1.0  OR  tight-gap with anchor top-3 Spd-avg3 + Class
  - **DUAL**: gap ≤ 1.0 AND #2 stronger by Spd/Class composite
  - **RECON**: small win, weak/contradictory data
  - **PASS**: field too wide or no clear top
- Bullring family (Finger Lakes, Thistledown, etc.): pace primary at sprints,
  PP veto/confirm at routes
- Generator: `cards_<date>/<track>/evaluate_v2.py` writes `evaluated.json`

---

## 3. Workout signal parsing + flag format — LOCKED

### Parser
`cards_<date>/<track>/parse_workouts.py` — reads `Workout(s):` lines from
`equibase.txt` in horse order, zips them with horses in `equibase.json`
(counts must match — assert at top).

### Equibase workout token grammar
`<dd> <Mon> <yy> <trk> [<surface mod>] <distF>F <surf> <time> <Breezing|Handily> [g] <rank>/<field>`
- `g` suffix = gate practice
- `rank == 1` = bullet
- Time formats: `:48.40`, `1:00.96`, `:50`

### Per-horse flag computation
- **BULLET**: any workout with `rank == 1` within last 30 days
- **GATE**: any workout with `g` suffix within last 21 days
- **SHARP**: 3F<36s OR 4F<49s OR 5F<61s OR 6F<74s within last 30 days
- **NO_WORK**: most recent workout ≥ 14 days ago

### Flag string format on `races.flags` (Jarvis DB)
Each workout signal becomes a string with emoji prefix:

```
🔥 BULLET on #N
⏱️ SHARP on #N
⏱️ GATE on #N
📉 NO WORK on #N
```

Stored as JSON array string on `races.flags`. Non-workout flags (drops in
class, hot trainer etc.) may live in the same array without emoji prefix.

Generator: `cards_<date>/<track>/relock_emoji_flags.py` (template lives in
the Belmont 2026-06-12 directory — copy and run per track).

### Emoji vocabulary (locked — these EXACT codepoints)
- `🔥` U+1F525 — BULLET
- `⏱️` U+23F1 U+FE0F — SHARP and GATE (same glyph, two semantics)
- `📉` U+1F4C9 — NO WORK

---

## 4. Jarvis card upload — LOCKED

- Endpoint: `POST /api/cards`
- Auth: Basic `EliteEdgeAnalytics:Austin08` + header `x-admin-pin: 5811`
- Body: `{card: insertCardSchema, races: [insertRaceSchema...], snapshot?}`
- Each race's `flags` field carries the emoji-prefixed workout array (§3)
- Each race's `read` field carries the simple `v2 PP-anchor: ...` sentence
  (NOT prose — Print renders `read`, not `whyText`)
- Patch endpoint for post-upload flag updates: `PATCH /api/races/:id/flags`
  with `{flags: string[]}`

---

## 5. Print PDF generation — LOCKED

(Already documented above — restating LOCK condition.)

- ALWAYS use `/home/user/workspace/handicapping/print_card_from_jarvis.py`
- Renders Jarvis `/#/print` page with headless Chromium
- Letter size, 0.4in margins, printBackground true, emulate print media
- NEVER use ReportLab generators (build_pdf.py, build_v2_pdf.py) — DELETED
  from active use as of this lock

---

## 6. Daily cron (eed6edd6) — LOCKED

`/home/user/workspace/email_picks/daily_send_instructions.md` updated to
use `print_card_from_jarvis.py`. Workflow unchanged: fetch active cards →
render PDF per card → email Tom at ann-tomyoung@comcast.net → update
sent_tracker.json.

---

## 7. Forbidden actions until v3 approved

- ❌ Don't invent new prose templates in `whyText`/`read`
- ❌ Don't add new tier names or change tier thresholds
- ❌ Don't change emoji glyphs or vocabulary
- ❌ Don't refactor parsers without keeping output schema identical
- ❌ Don't switch print PDF renderer
- ❌ Don't omit OTB/TwinSpires scratch-check before Jarvis upload
- ❌ Don't drop workout signals from the flags array

If a bug requires a fix, fix the bug. If a format question comes up, point
back to this lock. To change ANYTHING in this lock, Ken must say "approve v3".

