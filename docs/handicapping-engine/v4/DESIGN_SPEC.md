# EEA v4 Rating System — DESIGN SPEC (LOCKED 2026-06-12)

**Status:** LOCKED · ready for live use tonight (2026-06-12 night cards) and Saturday (2026-06-13)
**Author:** Computer / Ken
**Branch:** `feat/v4-rating-system`
**Tag (on commit):** `v4-lock-2026-06-12`

---

## 1. Purpose

v4 is a **composite rating system** that grades every horse in every race using
six features whose predictive lift was empirically measured on 23 graded races
from Belmont and Churchill (6/11 + 6/12 sample). It assigns each race one of
five conviction **tiers** — **SNIPER, EDGE, DUAL, RECON, PASS** — driving bet
sizing and ticket structure.

The **RECON stamp** is the headline change vs prior versions: it lets the
engine **rate every race** (no silent skips) and surface lower-conviction "we
noticed something" plays without forcing a big bet.

v4 **does not replace** the v3.2 track-bias engine. They layer together:
- **v4** picks anchor + tier from pre-race fundamentals
- **v3.2** layers in-card bias adjustments after 3 graded races

---

## 2. Feature weights (derived from 23-race sample)

Top-3 hit rates measured on n=23 graded races (Belmont 6/11 + Churchill 6/11 +
Belmont 6/12). Random baseline: ~34% top-3 hit at avg field size 7.

| Feature      | Top-3 hit | Lift vs random | Normalized weight |
|---           |---:       |---:            |---:               |
| Prime Power  | 65%       | 1.91×          | 0.209             |
| Pace Avg3    | 61%       | 1.78×          | 0.194             |
| Class Rating | 52%       | 1.53×          | 0.167             |
| Speed Avg3   | 48%       | 1.40×          | 0.153             |
| ML Odds      | 43%       | 1.27×          | 0.139             |
| JT %         | 43%       | 1.27×          | 0.139             |

Weights sum to 1.0. Stored in `calibration/v4_LOCKED_2026-06-12.json`.

---

## 3. Composite score (0–100)

For each horse in a race:

1. Rank within race for each feature (1 = best).
2. Convert rank → score: `rank_score = (field_size − rank + 1) / field_size`
   - #1 ranked = 1.0, last = ~0
3. Composite = `Σ (weight_i × rank_score_i) × 100`

Highest composite = race anchor.

---

## 4. Tier assignment

Applied to the anchor (top composite) of each race:

| Tier   | Condition | Bet recommendation |
|---     |---        |---                 |
| **SNIPER** | composite ≥ 90 AND prime_power rank = 1 AND pace_avg3 rank ≤ 2 | $25 WIN + $20 EXA key over composite top-3 |
| **EDGE**   | composite ≥ 80 AND prime_power rank ≤ 2                          | $15 WIN + $10 EXA key over composite top-3 |
| **DUAL**   | composite ≥ 70 AND prime_power rank ≤ 3                          | $10 EXA box anchor with composite #2. NO WIN. |
| **RECON**  | composite ≥ 60 OR (prime_power rank ≤ 3 AND 2+ top-3 confirms)   | **RECON STAMP** — $2–$5 EXA box only. NO WIN. Watch live odds. |
| **PASS**   | none of the above                                                | Skip race. |

"Top-3 confirms" = count of features where the anchor ranks ≤ 3.

---

## 5. Backtest results on the 23-race calibration sample

| Tier   | N  | Anchor win % | Winner in composite top-3 |
|---     |---:|---:          |---:                       |
| SNIPER | 2  | 50%          | 50%                       |
| EDGE   | 12 | 25%          | **67%**                   |
| DUAL   | 6  | 17%          | 50%                       |
| RECON  | 3  | 0%           | 33%                       |

Overall v4 anchor win rate: **22%** vs **14%** random (avg field 7) → **1.52× lift**.

**Notable v4 catches:**
- Belmont 6/11 R2 #2 My Magic Wand (EDGE) ✓
- Belmont 6/11 R5 **#11 Athena's Fury at 19/1** (EDGE) ✓
- Belmont 6/11 R6 #3 Judge Boushay (EDGE) ✓
- Churchill 6/11 R3 #2 Argan (only SNIPER, **hit**) ✓
- Belmont 6/12 R5 #1 (DUAL) ✓

**Key reads:**
- EDGE is the workhorse — bet **EXA top-3**, not WIN
- ML odds barely beat random → market is exploitable on overlays
- JT% adds little — keep as tiebreaker, not driver

---

## 6. Joint operation with v3.2 bias engine

For each race v4 generates a tier + anchor. For races where v3.2 bias is
active (≥3 graded races on the day):

1. v4 picks anchor + tier (fundamentals)
2. v3.2 adds bias adjustments:
   - Hot PP +1.5 to composite (can upgrade tier)
   - Dead PP −0.5 to composite (can downgrade tier)
   - Style match ±1.0
3. If a non-anchor horse in the field is on a HOT PP, v4 generates an
   additional EXA bridge ticket (#anchor / #hot_PP_horse)

Composite cap: confidence ≤ 0.85. Tier never auto-upgrades past SNIPER.

---

### 6a. Rollout status — v4 runs STANDALONE for now (layering = v4.1)

For the 2026-06-12 night cards and Saturday 2026-06-13, **v4 runs standalone**
alongside the existing v3.1 dashboard logic. The §6 v4 + v3.2 layering
(hot/dead-PP composite adjustments, EXA bridge tickets) is **planned for v4.1**
and is **not wired up yet** on `feat/v4-rating-system`:

- v4 surfaces its own anchor + tier per race via `GET /api/cards/:id/v4-grades`
  and the standalone `V4TierBadge` on each race card.
- The v3.2 track-bias panel (shipped separately in PR #64) continues to display
  on its own; **no v3.2 code is touched on this branch.**
- The two engines do **not** feed each other yet — a v4 tier is computed purely
  from pre-race fundamentals, and v3.2 bias adjustments are not applied to the
  v4 composite. That integration is the v4.1 deliverable.

The Python CLI (`docs/handicapping-engine/v4/eea_v4_rate.py`) is the manual
fallback for tonight: `python3 eea_v4_rate.py --jarvis <card_id>` grades a live
card straight from the Jarvis API if the dashboard preview isn't deployed.

---

## 7. Operator filter (carried over from v3.1)

Applied R3+ regardless of v4 tier:

- Anchor must have **SHARP or BULLET workout** in last 30d
- Sim ≥ 50% win prob (for WIN tickets) OR composite top-3 (for EXA)
- Live odds ≥ break-even × 1.25 (no chalk underlays)

If filter fails: **drop one tier** (SNIPER → EDGE, EDGE → DUAL, DUAL → RECON, RECON → PASS).

---

## 8. Lock parameters

```json
{
  "version": "v4-lock-2026-06-12",
  "locked_at": "2026-06-12T22:02 UTC",
  "weights": {
    "prime": 0.209,
    "class": 0.167,
    "spd3":  0.153,
    "pc3":   0.194,
    "jt":    0.139,
    "ml":    0.139
  },
  "tier_thresholds": {
    "SNIPER": {"composite": 90, "prime_rank": 1, "pc3_rank_max": 2},
    "EDGE":   {"composite": 80, "prime_rank_max": 2},
    "DUAL":   {"composite": 70, "prime_rank_max": 3},
    "RECON":  {"composite": 60, "fallback": "prime<=3 AND confirms>=2"}
  },
  "calibration_sample": "n=23 races (Belmont+Churchill 6/11, Belmont 6/12)",
  "calibration_file": "calibration/v4_LOCKED_2026-06-12.json"
}
```

---

## 9. Re-calibration policy

v4 weights stay LOCKED until either:
- 100+ additional graded races accumulate, OR
- User explicitly approves a v4.1

Any per-day tweaks happen via v3.2 bias adjustments, NOT by changing v4 weights.

---

## 10. Files

- `handicapping/eea_v4_rating_LOCKED.py` — Python reference implementation
- `handicapping/calibration/v4_LOCKED_2026-06-12.json` — weights snapshot
- `handicapping/calibration/v4_grades_23race_LOCKED.json` — backtest results
- `handicapping/v4_DESIGN_SPEC.md` — this file
- `server/services/v4_rating.ts` — TypeScript port (in dashboard)
- `client/src/components/V4TierBadge.tsx` — UI badge incl. RECON stamp
