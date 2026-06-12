# Handicapping Engine Changelog

## v3.1 — 2026-06-12 (Belmont @ The Big A, post-R4)

**Trigger:** 0-for-3 anchor failure (R1 Special Ops LAST, R2 Kiamba 5/6, R3 Opulent Restraint DEAD LAST). User authorized `approve v3`.

### New / Changed
| Change | v2 | v3.1 |
|---|---|---|
| `top_speed` weight | 0.60 | **0.25** |
| `power_rating` weight | 0.25 | 0.20 |
| `avg_class` weight | 0.15 | 0.20 |
| `pace_end` weight | **(not used)** | **0.35** (lower pace_end = better closer) |
| CLEAN workout adj | 0.0 | **−0.75** |
| SHARP workout adj | +0.5 | **+0.3** (no longer auto-protects) |
| Bet-down chalk penalty (live < 0.7×ML) | (none) | **−2.0** |
| Pace-end gate (pace_end > field median + 1.0) | (none) | **−0.75** |
| Dual-weakness (pace_early > 4.5 AND pace_end > 4.5) | (none) | **−1.5** |
| Figure-ceiling (top_speed gap ≥ 8 over field 2nd) | (none) | **−2.0** |
| Lone-front-on-turf-route (pace_early ≤ 2.5, only one < 3.5, surface=Turf, dist ≥ 7F) | (none) | **−2.0** |

### Backtest on 2026-06-12 Belmont R1–R3
| Race | v2 grade | v3.1 grade | Actual |
|---|---|---|---|
| R1 #2 Special Ops | SNIPER 65%+ | LEAN 52.5% | LAST |
| R2 #4 Kiamba | SNIPER 73.9% | LEAN 57.1% | 5/6 |
| R3 #3 Opulent Restraint | SNIPER 92.1% | **DUAL 45.2%** | DEAD LAST |
| R4 #4 Princess Ny (live) | STRONG 58.4% @ 7/2 | **PASS 33.3% @ 6/5 (underlay)** | 2nd to 9/2 longshot |

**v3.1 live call: R4 PASS — CORRECT.** Princess Ny finished 2nd to #6 K Gun. Model nailed the chalk failure pattern.

### Files
- `monte_carlo_v3.1.py` — current locked engine
- `monte_carlo_v2_archive.py` — pre-v3.1 baseline (do not use, retained for audit only)

### Locked status
**v3.1 LOCKED.** Do not modify until `approve v4` is given.

---

## v3.2 — 2026-06-13 (planned — IN DESIGN)

### Motivation
Belmont 2026-06-12 had extreme post-position + running-style bias:
- Post 6 won 5 of 7 races (R1, R3, R4, R6, R7)
- Post 1 won the other 2 (R2, R5)
- Posts 2, 3, 4, 5, 7 = 0 wins
- Pace-end winners (closers / best-finishers) dominated all 4 dirt sprints

No version of the model with no track-bias awareness could have caught this in real time.

### Planned changes
1. **Live track-bias detector**: after race 3 of any card, compute post-position win clustering and dominant running style. If a single PP has ≥ 60% win rate over the prior races, mark `track_bias_hot_pp`.
2. **Apply track bias to subsequent sims**:
   - `+1.5` base figure to horses in hot PP
   - `−0.5` to horses in dead-zone PPs (0 wins after ≥ 4 races)
   - `+1.0` to deep closers if 2+ winners were closers
   - `−1.0` to lone front-runners if no front-runners have won
3. **Re-grade trigger**: card-level "live recalibrate" endpoint that re-runs Monte Carlo on remaining races after each result is graded.

### Files (planned)
- `monte_carlo_v3.2.py` — new engine
- `track_bias_detector.py` — new sub-module
- `live_recalibrate.py` — re-grading orchestrator

---

## v2 — 2026-06-12 morning (locked at R2)
See `monte_carlo_v2_archive.py`. Superseded by v3.1.

## v1 — pre-2026-06-12
Baseline figure-weighted model. No chalk penalty, no pace_end signal, no track bias. **DO NOT REVERT** — same picks under any version, only v3.1+ catches today's chalk-failure pattern.
