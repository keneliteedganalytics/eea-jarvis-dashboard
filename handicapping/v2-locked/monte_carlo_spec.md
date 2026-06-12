# Monte Carlo & Multi-Race Exotic Workflow — v2 LOCKED 2026-06-12

**Locked by**: Kenneth Young
**Unlock phrase**: `approve v3`
**Files in this lock**:
- `monte_carlo.py` — per-race simulator
- `multi_race_tickets.py` — DD / Pick-3/4/5/6 ticket builder
- `monte_carlo_spec.md` — this document

---

## When to run

**Mandatory before every race we bet:**
1. After v2 grading completes (post-Stage 4 of the master workflow)
2. After OTB/TwinSpires late-drops are ingested
3. After any scratch within 30 minutes of post

**Optional but recommended:**
- Stress test on tier-borderline races (anchor PP gap 1.0-2.0)
- Premortem on every SNIPER bet ≥ $25 win exposure

---

## Per-race simulator workflow

```bash
# 1. Build input JSON from card data
#    See: /home/user/workspace/cards_<date>/<track>/sim_inputs/raceN.json

# 2. Run full sim + stress test + premortem
python3 /home/user/workspace/handicapping/monte_carlo.py \
    cards_2026-06-12/belmont/sim_inputs/race1.json --all

# 3. Re-run when conditions change (scratch, large odds move, weather)
```

### Locked formula

```
base_figure = 0.60 * top_speed + 0.25 * power_rating + 0.15 * avg_class
            + workout_adj + jt_adj

workout_adj:
  CLEAN         = 0.0
  BULLET        = +1.0
  SHARP         = +0.5
  BULLET+SHARP  = +1.5
  GATE          = +0.3
  NO_WORK       = -2.0

jt_adj = (jt_combo_pct - 20) * 0.05  # 20% baseline

pace_role (by Pace Early):
  PE < 2.9     → FRONT
  2.9 ≤ PE ≤ 6 → STALKER
  PE > 6       → CLOSER

pace_meltdown (probability 0.70 default):
  if meltdown:
    FRONT runners: figure -= 3.0  (duel penalty)
    STALKERS:      figure += 1.5
    CLOSERS:       figure += 0.5
  else (lone speed scenario):
    fastest_PE horse: figure += 2.0
    STALKERS:         figure += 0.5

per_race_variance: σ = 4.0 (Beyer-equivalent stdev)

N_full = 100,000  |  N_trials_display = 25  |  seed = 2026
```

### Recommended meltdown probability

| Field shape | Meltdown P |
|---|---|
| 3+ horses with PE ≤ 3.0 | 0.85 |
| 2 horses with PE ≤ 3.0 | 0.70 (default) |
| 1 horse with PE ≤ 3.0 | 0.55 |
| 0 horses with PE ≤ 3.0 | 0.30 (route or rate-y field) |

### Tier sizing decision from win %

| Anchor win % | Action | Win bet size |
|---|---|---|
| ≥ 65% | STRONG anchor — SNIPER size | $25 cap (or $30 if 25-trial = 17+/25) |
| 50-64% | LEAN anchor — EDGE size | $20 |
| 35-49% | DUAL territory | $15 + $10 EXA Box |
| < 35% | Reconsider anchor | $0 — pass or downsize |

ROI break-even at common odds:

| Odds | Win % needed |
|---|---|
| 9/5 | 36% |
| 5/2 | 29% |
| 3/1 | 25% |
| 7/2 | 22% |
| 5/1 | 17% |
| 8/1 | 11% |

---

## Premortem

After every SNIPER/STRONG anchor decision, run `--premortem`. It lists the top-4
loss scenarios ranked by their share of all losses, with a diagnostic "tell" for each.

**Read the tells before the race.** If you see the tell condition in the post parade
or at the gate, audible the bet (drop win amount, add place insurance).

### Hidden risks the model does NOT see

Always check manually before sizing up:

1. **Lifetime ITM% vs lifetime Win%** — if a horse hits the board often but rarely
   wins (e.g. 6 starts → 1W 0P 4S like Special Ops), the model overestimates win
   conversion. Downweight Win bet, keep EXA exposure.
2. **Track bias** — if R1 is the opener, no prior races to read from. Watch R1 live;
   if a closer wins from off the pace, bias is fair. If wire-to-wire, bias = speed,
   and re-grade later races.
3. **Equipment/medication day-of issues** — ~5% noise on all favorites.
4. **Trip trouble from post position** — inside posts in big fields, outside posts
   on tight turns, etc.
5. **Late scratches that flip the pace map** — if a key front-runner scratches,
   re-run the sim immediately.

---

## Multi-race exotic ticket builder

```bash
# 1. Build a ticket config JSON listing each leg's win-prob vector
#    (use win_probs from monte_carlo.py output JSON)

# 2. Run the builder
python3 /home/user/workspace/handicapping/multi_race_tickets.py \
    cards_2026-06-12/belmont/tickets/r1_r2_dd.json
```

### Locked tier classification per leg

| Tier | Win prob threshold | Use |
|---|---|---|
| A | ≥ 50% | Must use |
| B | 20-49% | Standard cover |
| C | 8-19% | Save / dart |
| D | < 8% | Omit |

### Locked candidate ticket structures

The builder generates and ranks three candidates for every multi-race bet:

**T1 — A-only** — single-key in every leg. Cheap, fires only if every A wins.
**T2 — A+B** — covers favorite + main contender per leg. Standard cover.
**T3 — Chalk key + ALL spread** — single horse in chalkiest leg, ALL in weakest leg, A+B elsewhere. Insurance ticket for sequences with one weak leg.

### Locked takeout assumptions (NYRA 2026)

| Bet | Takeout |
|---|---|
| DD | 17.5% |
| Pick 3 | 17.5% |
| **Pick 4** | **16.0%** ← best value |
| **Pick 5** | **15.0%** ← best value (often jackpot) |
| Pick 6 | 25.0% |

### Daily budget allocation — Belmont card ($1,000 total)

| Use | Allocation |
|---|---|
| Per-race win + exotics (TRI/EXA) | ~$100 × N races |
| Multi-race exotics (DD, P3, P4, P5) | $200 |
| Late audibles / reserves | $100 |

**Rule of thumb:** Don't commit more than 25% of daily budget ($250) to any single
multi-race exotic. Pick 6 only with carryover.

---

## Drift prevention

1. SHA-256 of this file + monte_carlo.py + multi_race_tickets.py are committed to
   GitHub at tag `v2-lock-2026-06-12-r2`.
2. Before every card session, verify the hashes match.
3. Any drift → stop and re-sync from the locked tag.
4. Only `approve v3` releases the lock.
