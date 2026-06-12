# Handicapping Engine v3.2 — Design Spec
**Date:** 2026-06-12 (designed same evening as v3.1 ship)  
**Status:** DESIGN — not yet implemented  
**Trigger:** v3.1 caught the chalk-failure pattern but missed the bigger signal — **track bias**. Today (Belmont) had extreme PP + running-style bias that no static figure model can detect.

---

## 1. Empirical Evidence (Belmont 2026-06-12)

| Race | Surf | Dist | Winner # | Winner Style | Winner PP | Win$ |
|---|---|---|---|---|---|---:|
| R1 | Dirt | 6F | 6 Five Wishes | Deep closer (PE 2.2) | **6** | $5.50 |
| R2 | Turf | 1⅜M | 1 Agia Marina | Best pace_end (3.5) | 1 | $10.78 |
| R3 | Turf | 1 1/16M | 6 Peak Hype | Closer (PE 3.2) | **6** | $12.82 |
| R4 | Dirt | 6½F | 6 K Gun | Deep closer | **6** | $10.78 |
| R5 | Turf | 1 1/16M | 1 Dimensionality | — | 1 | $8.72 |
| R6 | Turf | 5½F | 6 Ghost Me | — | **6** | $5.20 |
| R7 | Dirt | 7F | 6 Golden Symphony | — | **6** | $7.06 |

**Post 6 won 5 of 7 (71%). Post 1 won the other 2. Posts 2/3/4/5/7 = 0 wins.**

In a 6–7 horse field, random PP win rate ≈ 14–16%. Post 6 ran at **4–5× expected.** That's not noise — that's track surface, rail configuration, or weather creating a real-time bias the model could not see this morning.

---

## 2. v3.2 Core Additions

### 2.1 Track-Bias Detector
**Module:** `track_bias_detector.py`

After each race is graded on a card, recompute:

```
hot_pp_threshold = 0.45         # >= 45% of races won from same PP
dead_pp_threshold = 0           # 0 wins after at least 4 races
min_races_for_signal = 3        # need 3+ graded races before activating
```

**Algorithm:**
1. Read all graded results on the current card.
2. If `n_graded < min_races_for_signal`: return `{"active": false}`.
3. Compute `pp_wins[pp] = count(races where winner.pp == pp) / n_graded`.
4. Identify `hot_pps = {pp for pp, rate in pp_wins.items() if rate >= hot_pp_threshold}`.
5. Identify `dead_pps = {pp for pp in all_pps_seen if pp_wins[pp] == 0 and n_graded >= 4}`.
6. Compute `winning_styles = [classify_pace_role(winner.pace_early) for race in graded]`.
7. If `≥ 60%` of winners are CLOSER → `style_bias = "CLOSER"`.
   If `≥ 60%` are FRONT → `style_bias = "FRONT"`.
   Else `style_bias = None`.

**Return:**
```json
{
  "active": true,
  "n_graded": 4,
  "hot_pps": [6],
  "dead_pps": [2, 3, 5],
  "style_bias": "CLOSER",
  "confidence": 0.71
}
```

### 2.2 Bias Adjustments (applied in `base_figure` or post-base)
```python
TRACK_BIAS_HOT_PP_BONUS = +1.5
TRACK_BIAS_DEAD_PP_PENALTY = -0.5
STYLE_BIAS_CLOSER_BONUS = +1.0      # to deep closers (PE > 6.0)
STYLE_BIAS_FRONT_PENALTY = -1.0     # to lone front-runners when closers winning
STYLE_BIAS_FRONT_BONUS = +1.0       # to front-runners when fronts winning
STYLE_BIAS_CLOSER_PENALTY = -1.0    # to closers when fronts winning
```

### 2.3 Live Recalibration Endpoint
**New API route:** `POST /api/cards/:id/recalibrate-from-bias`

After each result is posted to Jarvis:
1. Auto-trigger bias detector for the card.
2. If `active == true` AND `n_graded >= min_races_for_signal`:
3. Re-run Monte Carlo on all **remaining (ungraded)** races with bias adjustments.
4. Update each remaining race's `whyText` with a bias annotation: `"v3.2 BIAS UPDATE: hot post = 6, style bias = CLOSER. Anchor PP=4 → no PP bonus. Anchor pace_early=2.5 → +1.0 closer bonus applied."`
5. Re-grade tiers based on new win%.
6. Push a websocket event so the live dashboard updates.

### 2.4 Pre-Card Track-Bias Carryover (stretch goal)
Pull the prior 3 race days at the same track. If post-6 won ≥ 40% over that window → apply a **soft initial bias** (+0.75, not +1.5) starting from race 1 of today's card. Decay rapidly as today's data accumulates.

---

## 3. Backtest Plan

### 3.1 Replay Belmont 2026-06-12 under v3.2

For each of R1–R7, simulate the live recalibration as if v3.2 were running:
- R1, R2, R3: no bias active yet (n_graded < 3).
- R4 (after R1–R3 graded): bias signal activates. Post-6 has 2/3 wins → `hot_pps = [6]`. Style = mixed. Apply +1.5 to any horse drawn in post 6. R4 had **#6 K Gun (9/2 ML)** in field. Re-grade his win% — would v3.2 have flagged him?
- R5: hot_pps still [6], style still mixed. R5 had **#1 Dimensionality** in field. No PP bonus, but is there a #6 contender that v3.2 would have boosted?
- R6: bias signal stronger (3/5 post-6 wins). R6 won by #6 Ghost Me — v3.2 should have grade him much higher.
- R7: bias extreme (4/6 post-6 wins, ~67%). R7 won by #6 Golden Symphony — v3.2 should have flagged him as SNIPER/EDGE.

**Success criterion:** v3.2 grades #6 winner in **at least R6 + R7** as EDGE-or-better. Bonus: catches #6 K Gun in R4 as a DUAL/EXA add.

### 3.2 No-bias-day sanity check
Replay Saratoga 2026-06-11 (different card, no extreme bias) under v3.2. Verify the model does NOT degrade — bias should never activate strongly because no PP dominates.

---

## 4. Implementation Order

| # | Task | File | Est. effort |
|---|---|---|---|
| 1 | Implement `TrackBiasDetector` class | `handicapping/track_bias_detector.py` | 1 hr |
| 2 | Add bias adjustments to `base_figure` (gated by `bias_state` param) | `handicapping/monte_carlo.py` | 30 min |
| 3 | Add CLI flag `--bias-state <json_file>` for off-line backtesting | `handicapping/monte_carlo.py` | 15 min |
| 4 | Replay 2026-06-12 Belmont R1–R7 under v3.2 | `handicapping/backtest_v3.2_belmont.py` | 1 hr |
| 5 | Add Jarvis API endpoint `POST /api/cards/:id/recalibrate-from-bias` | `eea-jarvis-dashboard/server/routes.ts` + storage | 2 hr |
| 6 | Wire auto-trigger after `POST /api/races/:id/result` | `eea-jarvis-dashboard/server/routes.ts` | 30 min |
| 7 | Add bias panel to dashboard UI | `eea-jarvis-dashboard/client/...` | 2 hr |
| 8 | E2E test on Saturday's card (paper trade) | live | 1 day |
| 9 | Lock + tag v3.2 if E2E passes | git | 5 min |

**Total dev time before paper trade: ~5–6 hours of coding.**  
**Validation: 1 paper-trade day (Saturday).**  
**Earliest live deployment: Sunday or Monday.**

---

## 5. Risk Considerations

### What could break
- **Small sample bias**: 3 races is a tiny sample. A horse winning post-6 twice in 3 races is 67%, but could be random. Mitigation: only activate at `n_graded >= 3` AND `rate >= 45%` (more than chance, less than overfit).
- **Surface flip mid-card**: a card with both dirt and turf races may have surface-specific biases. Mitigation: optionally segment bias detection by surface in v3.3.
- **Self-reinforcing chalk**: if we boost a post-6 horse to SNIPER, others may too, and we re-create the chalk-failure pattern we just fixed. Mitigation: **bias bonus does NOT override v3.1 chalk penalty**. A post-6 horse who is also a bet-down chalk still gets the −2.0.

### What stays locked
- All v3.1 changes remain in effect. v3.2 is **additive** — adjustments layer on top.
- No reverting to v1 under any circumstance.

---

## 6. Acceptance Criteria

v3.2 is LOCKED when:
1. ✅ Implemented & all unit tests pass
2. ✅ Backtest on 2026-06-12 Belmont R6 + R7 grades #6 winners as EDGE-or-better
3. ✅ Backtest on a no-bias day shows no degradation (≤ 5% grade shift vs v3.1)
4. ✅ Live paper-trade Saturday with bias panel visible in dashboard
5. ✅ User reviews + types `approve v3.2`

Until then: **v3.1 stays locked and active.**
