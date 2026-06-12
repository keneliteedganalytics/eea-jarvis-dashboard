#!/usr/bin/env python3
"""
Elite Edge Analytics — Race Monte Carlo Simulator (v2 LOCKED 2026-06-12)

LOCKED. Do not modify until "approve v3" is given.

USAGE:
    python3 monte_carlo.py <race_input.json> [--trials N] [--seed S] [--meltdown-prob P]
    python3 monte_carlo.py <race_input.json> --stress-test          # sweep meltdown 40-95%
    python3 monte_carlo.py <race_input.json> --premortem            # premortem analysis

INPUT JSON SCHEMA (race_input.json):
{
  "race": {
    "track": "Belmont",
    "race_number": 1,
    "distance_f": 6.0,
    "surface": "Dirt",           # Dirt | Turf | AWS
    "field_size": 5,             # post-scratch
    "anchor_pgm": "2"            # the horse the simulator focuses on
  },
  "horses": [
    {
      "pgm": "2",
      "name": "Special Ops",
      "power_rating": 82.6,      # OTB/TwinSpires Power (or Brisnet PP if OTB missing)
      "top_speed": 93,           # OTB Top Speed or Brisnet Spd-avg3
      "avg_class": 81,           # OTB Avg Class
      "pace_early": 5.0,         # OTB Pace Early (lower = faster early)
      "pace_end": 3.9,           # OTB Pace End (lower = better closer)
      "jt_combo_pct": 22,        # OTB Combined J/T Win% (small-sample J/T at this meet)
      "workout": "CLEAN",        # CLEAN | BULLET | SHARP | BULLET+SHARP | GATE | NO_WORK
      "ml_odds": "9/5",
      "current_odds": "9/5",
      "lifetime_itm_pct": 83     # Wins+Place+Show / Starts (lifetime, optional)
    },
    ...
  ]
}

FORMULAS (LOCKED — do not modify):
  base_figure = 0.60*top_speed + 0.25*power_rating + 0.15*avg_class
              + workout_adj + jt_adj

  workout_adj:  CLEAN=0, BULLET=+1.0, SHARP=+0.5, BULLET+SHARP=+1.5,
                GATE=+0.3, NO_WORK=-2.0

  jt_adj = (jt_combo_pct - 20) * 0.05    # 20% baseline

  pace_meltdown: True with probability P (default 0.70)
    A pace meltdown is the most common shape when 2+ horses have Pace Early ≤ 3.0.
    P should be raised toward 0.85 if 3+ early types, lowered toward 0.55 if only one.

  In meltdown:
    - All horses with Pace Early ≤ 3.0:  realized figure -= 3.0 (duel penalty)
    - Stalker (3.0 < Pace Early ≤ 6.0):  realized figure += 1.5
    - Deep closer (Pace Early > 6.0):    realized figure += 0.5

  No meltdown (lone speed):
    - The fastest Pace Early gets +2.0 (uncontested lead)
    - Stalker gets +0.5

  Per-horse realized figure = gauss(adjusted_base, sigma=4.0)

  Standard sample size: N = 100,000 sims for full Monte Carlo,
                        N = 25 for individual-trial display.

OUTPUT:
  - Win % per horse (full field)
  - Anchor H2H % vs each other contender
  - $X WIN expected value at current odds for the anchor
  - Stress test: same metrics across meltdown prob 40-95%
  - Premortem: top-4 loss scenarios with diagnostic tells

INVARIANTS (sanity checks, abort if violated):
  - Sum of win % must == 100% (within float tolerance)
  - Each horse field count must == race.field_size
  - Anchor must appear in horses list
  - No horse may have base figure below 50 or above 110 (data error)

HOW TO READ:
  - Anchor win % > 65% → STRONG (size up to SNIPER cap $25, or $30 if vs 1 confirmer)
  - Anchor win % 50-65% → LEAN (size to EDGE $20)
  - Anchor win % 35-50% → DUAL territory (size $15 + EXA Box)
  - Anchor win % < 35% → reconsider anchor; verify v2 PP gap, scratches, workout veto

  ROI break-even at odds K/L:  win_pct_needed = L / (K + L)
    9/5 → 36%   |   5/2 → 29%   |   3/1 → 25%   |   7/2 → 22%   |   5/1 → 17%
"""

import argparse
import json
import math
import random
import sys
from collections import Counter

# ─── LOCKED CONSTANTS ──────────────────────────────────────────────────────
WORKOUT_ADJ = {
    "CLEAN": 0.0,
    "BULLET": 1.0,
    "SHARP": 0.5,
    "BULLET+SHARP": 1.5,
    "GATE": 0.3,
    "NO_WORK": -2.0,
}
SIGMA = 4.0                 # per-race variance
PE_FRONT_THRESHOLD = 2.9    # Pace Early < this = front-runner candidate (exclusive at 2.9)
PE_STALKER_MAX = 6.0
DUEL_PENALTY = 3.0
STALKER_BONUS = 1.5
CLOSER_BONUS = 0.5
LONE_SPEED_BONUS = 2.0
DEFAULT_MELTDOWN_PROB = 0.70
DEFAULT_N_FULL = 100_000
DEFAULT_N_TRIALS = 25
DEFAULT_SEED = 2026
JT_BASELINE = 20
JT_FACTOR = 0.05
# ───────────────────────────────────────────────────────────────────────────


def base_figure(h):
    """Compute the LOCKED base figure for a horse."""
    wk = h["workout"]
    if wk not in WORKOUT_ADJ:
        raise ValueError(f"Unknown workout type '{wk}' for #{h['pgm']} {h['name']}")
    base = 0.60 * h["top_speed"] + 0.25 * h["power_rating"] + 0.15 * h["avg_class"]
    base += WORKOUT_ADJ[wk]
    base += (h["jt_combo_pct"] - JT_BASELINE) * JT_FACTOR
    return base


def classify_pace_role(pe):
    # LOCKED: PE < 2.9 = FRONT, 2.9 ≤ PE ≤ 6.0 = STALKER, PE > 6.0 = CLOSER
    if pe < PE_FRONT_THRESHOLD:
        return "FRONT"
    if pe <= PE_STALKER_MAX:
        return "STALKER"
    return "CLOSER"


def simulate_race(horses, bases, meltdown_prob, rng):
    """Run a single race. Returns (ordered_list_of_tuples, meltdown_bool)."""
    meltdown = rng.random() < meltdown_prob
    # Identify the fastest-early horse for lone-speed scenario
    fastest_early_pgm = min(horses, key=lambda p: horses[p]["pace_early"])
    figures = {}
    for pgm, h in horses.items():
        f = bases[pgm]
        role = classify_pace_role(h["pace_early"])
        if meltdown:
            if role == "FRONT":
                f -= DUEL_PENALTY
            elif role == "STALKER":
                f += STALKER_BONUS
            elif role == "CLOSER":
                f += CLOSER_BONUS
        else:
            if pgm == fastest_early_pgm:
                f += LONE_SPEED_BONUS
            elif role == "STALKER":
                f += STALKER_BONUS * 0.33   # 0.5 — smaller without duel
        realized = rng.gauss(f, SIGMA)
        figures[pgm] = realized
    order = sorted(figures.items(), key=lambda x: -x[1])
    return order, meltdown


def parse_odds(odds_str):
    """Convert '9/5' or '5/2' or '4' to decimal (profit per $1 stake)."""
    s = str(odds_str).strip()
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b)
    return float(s)


def validate_input(data):
    assert "race" in data and "horses" in data, "Input must have 'race' and 'horses'"
    race = data["race"]
    horses = data["horses"]
    assert len(horses) == race["field_size"], (
        f"field_size={race['field_size']} but {len(horses)} horses in list"
    )
    anchor = race["anchor_pgm"]
    assert any(h["pgm"] == anchor for h in horses), (
        f"anchor_pgm '{anchor}' not found in horses"
    )
    for h in horses:
        b = 0.60 * h["top_speed"] + 0.25 * h["power_rating"] + 0.15 * h["avg_class"]
        if not (50 <= b <= 110):
            raise ValueError(
                f"#{h['pgm']} {h['name']} base figure {b:.1f} out of range [50, 110]. "
                f"Check input data."
            )


def run_monte_carlo(data, meltdown_prob, n_full, n_trials, seed):
    validate_input(data)
    race = data["race"]
    horses = {h["pgm"]: h for h in data["horses"]}
    bases = {p: base_figure(h) for p, h in horses.items()}
    anchor = race["anchor_pgm"]

    # PART 1: Base figures
    print("=" * 78)
    print(f"MONTE CARLO — {race['track']} R{race['race_number']}  "
          f"({race['distance_f']}F {race['surface']}, "
          f"{race['field_size']} runners)")
    print("=" * 78)
    print(f"\n— Base figures (locked formula) —")
    for p, b in sorted(bases.items(), key=lambda x: -x[1]):
        role = classify_pace_role(horses[p]["pace_early"])
        marker = "  ★ ANCHOR" if p == anchor else ""
        print(f"  #{p} {horses[p]['name']:<24} {b:6.2f}   role={role:<8}{marker}")

    # PART 2: 25 individual trials
    rng = random.Random(seed)
    print(f"\n— {n_trials} INDIVIDUAL TRIALS (seed={seed}, meltdown_prob={meltdown_prob:.0%}) —")
    trial_winners = Counter()
    meltdown_count = 0
    for trial in range(1, n_trials + 1):
        order, meltdown = simulate_race(horses, bases, meltdown_prob, rng)
        if meltdown:
            meltdown_count += 1
        trial_winners[order[0][0]] += 1
    print(f"  Pace meltdowns: {meltdown_count}/{n_trials} = {meltdown_count/n_trials:.0%}")
    print(f"  Winner tally:")
    for p, c in trial_winners.most_common():
        print(f"    #{p} {horses[p]['name']:<24} {c:>2}/{n_trials} = {c/n_trials:.0%}")

    # PART 3: Full Monte Carlo
    rng = random.Random(seed)
    print(f"\n— {n_full:,} SIMULATIONS —")
    win_counts = Counter()
    h2h_anchor = Counter()
    for _ in range(n_full):
        order, _ = simulate_race(horses, bases, meltdown_prob, rng)
        win_counts[order[0][0]] += 1
        anchor_pos = next(i for i, (p, _) in enumerate(order) if p == anchor)
        for i, (p, _) in enumerate(order):
            if p == anchor:
                continue
            if anchor_pos < i:
                h2h_anchor[p] += 1
    print(f"  Race winner distribution:")
    for p, c in sorted(win_counts.items(), key=lambda x: -x[1]):
        anchor_mark = "  ← anchor" if p == anchor else ""
        print(f"    #{p} {horses[p]['name']:<24} {c/n_full:>6.1%}{anchor_mark}")
    print(f"\n  Head-to-head: #{anchor} {horses[anchor]['name']} finishes ahead of:")
    for p in horses:
        if p == anchor:
            continue
        pct = h2h_anchor[p] / n_full
        print(f"    #{p} {horses[p]['name']:<24} {pct:>6.1%}")

    # PART 4: ROI on anchor
    anchor_h = horses[anchor]
    anchor_win = win_counts[anchor] / n_full
    odds = parse_odds(anchor_h["current_odds"])
    ev_per_dollar = anchor_win * odds - (1 - anchor_win)
    breakeven = 1 / (odds + 1)
    print(f"\n  Anchor #{anchor} {anchor_h['name']} @ {anchor_h['current_odds']}:")
    print(f"    win% = {anchor_win:.1%}   |   break-even = {breakeven:.1%}")
    print(f"    Expected ROI per $1 win bet: {ev_per_dollar*100:+.1f}%")
    rec = ("STRONG anchor — size to SNIPER cap" if anchor_win > 0.65
           else "LEAN anchor — size to EDGE base" if anchor_win > 0.50
           else "DUAL territory — consider EXA Box instead of WIN"
           if anchor_win > 0.35
           else "RECONSIDER ANCHOR")
    print(f"    Recommendation: {rec}")

    return {
        "race": race,
        "win_pct": {p: win_counts[p] / n_full for p in horses},
        "h2h_anchor": {p: h2h_anchor[p] / n_full for p in horses if p != anchor},
        "anchor_win_pct": anchor_win,
        "anchor_ev_per_dollar": ev_per_dollar,
        "anchor_breakeven_pct": breakeven,
        "trial_winners": dict(trial_winners),
        "meltdown_count_in_trials": meltdown_count,
        "n_trials": n_trials,
        "n_full": n_full,
        "meltdown_prob": meltdown_prob,
        "seed": seed,
    }


def run_stress_test(data, seed):
    validate_input(data)
    race = data["race"]
    horses = {h["pgm"]: h for h in data["horses"]}
    bases = {p: base_figure(h) for p, h in horses.items()}
    anchor = race["anchor_pgm"]
    anchor_h = horses[anchor]
    odds = parse_odds(anchor_h["current_odds"])
    n = 100_000

    print("\n" + "=" * 78)
    print(f"STRESS TEST — sweep pace-meltdown probability 40% → 95%")
    print("=" * 78)
    print(f"\nAnchor: #{anchor} {anchor_h['name']} @ {anchor_h['current_odds']} "
          f"(break-even {1/(odds+1):.0%})")
    print(f"\n{'Meltdown%':<12}{'Anchor Win%':<14}", end="")
    others = [p for p in horses if p != anchor]
    for p in others:
        print(f"#{p} Win%   ", end="")
    print(f"{'$1 ROI':<10}{'Verdict'}")
    print("-" * 100)

    for prob in [0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]:
        rng = random.Random(seed)
        win_counts = Counter()
        for _ in range(n):
            order, _ = simulate_race(horses, bases, prob, rng)
            win_counts[order[0][0]] += 1
        anchor_win = win_counts[anchor] / n
        ev = anchor_win * odds - (1 - anchor_win)
        verdict = ("STRONG" if anchor_win > 0.65 else "LEAN" if anchor_win > 0.50
                   else "TOSS-UP" if anchor_win > 0.35 else "FADE")
        print(f"{prob*100:>4.0f}%       {anchor_win:>6.1%}        ", end="")
        for p in others:
            print(f" {win_counts[p]/n:>5.1%}   ", end="")
        print(f"{ev*100:+>6.1f}%   {verdict}")


def run_premortem(data, sim_result):
    """Print top-4 loss scenarios for the anchor."""
    race = data["race"]
    horses = {h["pgm"]: h for h in data["horses"]}
    anchor = race["anchor_pgm"]
    anchor_h = horses[anchor]
    anchor_win = sim_result["anchor_win_pct"]
    loss_pct = 1 - anchor_win

    print("\n" + "=" * 78)
    print(f"PREMORTEM — anchor #{anchor} {anchor_h['name']} loses ({loss_pct:.0%} of races)")
    print("=" * 78)

    # Rank contenders by their win % (these are the people who beat us)
    others = [(p, h, sim_result["win_pct"][p]) for p, h in horses.items() if p != anchor]
    others.sort(key=lambda x: -x[2])

    print("\nTOP LOSS SCENARIOS (ranked):\n")
    for i, (p, h, w) in enumerate(others[:4], 1):
        scenario_share = w / loss_pct if loss_pct > 0 else 0
        pe = h["pace_early"]
        role = classify_pace_role(pe)
        wk = h["workout"]
        jt = h["jt_combo_pct"]
        print(f"  {i}. #{p} {h['name']} wins")
        print(f"     • Probability of this loss: {w:.1%} of all races "
              f"({scenario_share:.0%} of all losses)")
        print(f"     • Pace role: {role} (PE={pe})  |  Workout: {wk}  |  J/T: {jt}%")
        # Diagnostic tell
        if role == "FRONT" and pe <= 2.5:
            tell = f"Watch the break — if #{p} clears and isn't pressed, this is happening"
        elif jt >= 30:
            tell = f"Smart-money signal: J/T combo {jt}% is the connections angle"
        elif wk in ("BULLET", "BULLET+SHARP"):
            tell = f"Sharp workout pattern — barn has him ready"
        elif role == "CLOSER":
            tell = f"Needs the duel up front to materialize; if pace meltdown is severe, he gets there"
        else:
            tell = f"Generic upset — variance covers this band"
        print(f"     • Tell: {tell}")
        print()

    # Tier-2 hidden risks (model-blind)
    print("HIDDEN RISKS (model doesn't see these):\n")
    lifetime = anchor_h.get("lifetime_itm_pct")
    print(f"  • Lifetime pattern: {anchor_h['name']} ITM% = "
          f"{str(lifetime) + '%' if lifetime is not None else 'n/a'}.")
    print(f"    If ITM% high but Win% low historically, model may overestimate win conversion.")
    print(f"  • Track bias (unknown if this is R1 — no prior races to read).")
    print(f"  • Equipment/medication day-of issues (~5% base rate on all favorites).")
    print(f"  • Trip trouble from post {anchor} in {race['field_size']}-horse field.")
    print(f"  • Late scratch shifts the pace map.")


def main():
    ap = argparse.ArgumentParser(description="Race Monte Carlo simulator (LOCKED v2)")
    ap.add_argument("input_json", help="Path to race input JSON")
    ap.add_argument("--trials", type=int, default=DEFAULT_N_TRIALS)
    ap.add_argument("--full-n", type=int, default=DEFAULT_N_FULL)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--meltdown-prob", type=float, default=DEFAULT_MELTDOWN_PROB)
    ap.add_argument("--stress-test", action="store_true", help="Sweep meltdown 40-95%")
    ap.add_argument("--premortem", action="store_true", help="Top-4 loss scenarios")
    ap.add_argument("--all", action="store_true", help="Run sim + stress + premortem")
    ap.add_argument("--json-out", help="Write result JSON to this path")
    args = ap.parse_args()

    with open(args.input_json) as f:
        data = json.load(f)

    do_stress = args.stress_test or args.all
    do_pre = args.premortem or args.all

    result = run_monte_carlo(data, args.meltdown_prob, args.full_n, args.trials, args.seed)
    if do_stress:
        run_stress_test(data, args.seed)
    if do_pre:
        run_premortem(data, result)
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(result, f, indent=2, default=str)
        print(f"\n[wrote {args.json_out}]")


if __name__ == "__main__":
    main()
