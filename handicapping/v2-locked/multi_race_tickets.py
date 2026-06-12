#!/usr/bin/env python3
"""
Elite Edge Analytics — Multi-Race Exotic Ticket Builder (v2 LOCKED 2026-06-12)

Builds DD / Pick 3 / Pick 4 / Pick 5 / Pick 6 tickets from per-race Monte Carlo
win-probability vectors.

LOCKED. Do not modify until "approve v3" is given.

USAGE:
    python3 multi_race_tickets.py <ticket_config.json>

INPUT JSON SCHEMA:
{
  "bet_type": "PICK_4",       # DD | PICK_3 | PICK_4 | PICK_5 | PICK_6
  "base_amount": 0.50,        # $ per combination (track minimum, usually 0.50 or 1.00)
  "budget": 50,               # max $ to spend on this ticket
  "legs": [
    {
      "race": 1,
      "anchor": "2",          # primary key
      "win_probs": {"1": 0.00, "2": 0.69, "3": 0.005, "4": 0.031, "6": 0.272}
    },
    ...
  ]
}

LOCKED LOGIC:
  1. For each leg, classify horses into tiers based on win probability:
       A: win_prob ≥ 0.50  (must-use)
       B: 0.20 ≤ win_prob < 0.50
       C: 0.08 ≤ win_prob < 0.20
       D: win_prob < 0.08  (omit)

  2. Build three candidate tickets:
       T1 = A in every leg (cheapest, max conviction)
       T2 = A+B in every leg (standard cover)
       T3 = A+B in primary legs, A in chalkiest leg, ALL in weakest leg
            (insurance ticket — only if weakest leg has anchor < 0.50)

  3. Compute for each:
       cost = base * (prod of leg sizes)
       hit_prob = prod of (sum of win_probs of selected horses in each leg)
       expected_pool_payoff = (1 / hit_prob) * (1 - takeout) * base  (rough)
       ev_per_dollar = hit_prob * expected_pool_payoff / cost - 1

  4. Output: each ticket structure with cost, hit prob, and a "value rank"

LOCKED TAKEOUT ASSUMPTIONS (NY/NYRA tracks 2026):
  DD     : 17.5%
  PICK_3 : 17.5%
  PICK_4 : 16.0%    ← best value
  PICK_5 : 15.0%    ← best value (often jackpot)
  PICK_6 : 25.0%    ← jackpot fund-style

  Note: real ROI depends on pool size and chalk. These are PRIORS for ranking
  candidate tickets — not predictions of actual payout.
"""

import argparse
import json
from itertools import product

# ─── LOCKED CONSTANTS ──────────────────────────────────────────────────────
TAKEOUT = {
    "DD": 0.175,
    "PICK_3": 0.175,
    "PICK_4": 0.16,
    "PICK_5": 0.15,
    "PICK_6": 0.25,
}
TIER_THRESHOLDS = {
    "A": 0.50,
    "B": 0.20,
    "C": 0.08,
}
N_LEGS = {"DD": 2, "PICK_3": 3, "PICK_4": 4, "PICK_5": 5, "PICK_6": 6}
# ───────────────────────────────────────────────────────────────────────────


def classify_horses(win_probs):
    """Return tiered horse lists for one leg."""
    tiers = {"A": [], "B": [], "C": [], "D": []}
    for pgm, p in win_probs.items():
        if p >= TIER_THRESHOLDS["A"]:
            tiers["A"].append((pgm, p))
        elif p >= TIER_THRESHOLDS["B"]:
            tiers["B"].append((pgm, p))
        elif p >= TIER_THRESHOLDS["C"]:
            tiers["C"].append((pgm, p))
        else:
            tiers["D"].append((pgm, p))
    for t in tiers:
        tiers[t].sort(key=lambda x: -x[1])
    return tiers


def ticket_metrics(selections, base_amount, bet_type):
    """
    selections: list of dicts, one per leg, mapping pgm -> win_prob
    base_amount: $ per combo
    bet_type: DD | PICK_3 | etc.

    Returns (cost, hit_prob, expected_payoff_per_winning_ticket, ev_per_dollar)
    """
    n_combos = 1
    hit_prob = 1.0
    for leg in selections:
        n_combos *= len(leg)
        hit_prob *= sum(leg.values())
    cost = n_combos * base_amount
    # Rough payoff: assumes the pool clears at (1/hit_prob) * base after takeout
    # This is just a ranking heuristic — real payoff depends on the public's tickets
    if hit_prob > 0:
        # Naive fair-payout expectation
        gross = base_amount / hit_prob
        net = gross * (1 - TAKEOUT[bet_type])
        ev = hit_prob * net - cost / n_combos
        ev_per_dollar = (hit_prob * net * n_combos - cost) / cost if cost > 0 else 0
    else:
        net = 0
        ev_per_dollar = -1.0
    return cost, hit_prob, net, ev_per_dollar


def build_ticket_candidates(legs, bet_type, base, budget):
    """
    Build T1 (A-only), T2 (A+B), T3 (anchor key with ALL on weakest leg).
    Returns list of (name, selections_per_leg, cost, hit_prob, ev_per_dollar, notes).
    """
    candidates = []
    leg_tiers = [classify_horses(L["win_probs"]) for L in legs]
    n_legs = len(legs)

    # ─ T1: A-only in every leg ─
    t1_legs = []
    feasible = True
    for i, tiers in enumerate(leg_tiers):
        if not tiers["A"]:
            feasible = False
            break
        sel = {pgm: p for pgm, p in tiers["A"]}
        t1_legs.append(sel)
    if feasible:
        cost, hp, net, ev = ticket_metrics(t1_legs, base, bet_type)
        if cost <= budget:
            candidates.append(("T1 A-only", t1_legs, cost, hp, ev,
                               "Max conviction — only fires if every A wins"))

    # ─ T2: A+B in every leg ─
    t2_legs = []
    for tiers in leg_tiers:
        sel = {pgm: p for pgm, p in (tiers["A"] + tiers["B"])}
        if not sel:
            # No A or B horses — punt by adding top C
            sel = {pgm: p for pgm, p in tiers["C"][:1]}
        t2_legs.append(sel)
    cost, hp, net, ev = ticket_metrics(t2_legs, base, bet_type)
    if cost <= budget:
        candidates.append(("T2 A+B all legs", t2_legs, cost, hp, ev,
                           "Standard cover — handles favorite + main contender per leg"))

    # ─ T3: A in chalkiest leg + ALL in weakest ─
    # "Chalkiest" = leg with highest single horse win prob
    # "Weakest" = leg with most horses in B/C tier (most spread)
    chalk_idx = max(range(n_legs),
                    key=lambda i: max(legs[i]["win_probs"].values()))
    weak_idx = max(range(n_legs),
                   key=lambda i: len(leg_tiers[i]["B"]) + len(leg_tiers[i]["C"]))
    if chalk_idx != weak_idx:
        t3_legs = []
        for i, tiers in enumerate(leg_tiers):
            if i == chalk_idx:
                sel = {pgm: p for pgm, p in tiers["A"][:1]}  # just the top A
            elif i == weak_idx:
                # All horses with prob > 0
                sel = {pgm: p for pgm, p in legs[i]["win_probs"].items() if p > 0}
            else:
                sel = {pgm: p for pgm, p in (tiers["A"] + tiers["B"])}
            if not sel:
                sel = {pgm: p for pgm, p in tiers["A"] + tiers["B"] + tiers["C"]}
            t3_legs.append(sel)
        cost, hp, net, ev = ticket_metrics(t3_legs, base, bet_type)
        if cost <= budget:
            candidates.append(
                (f"T3 chalk-key R{legs[chalk_idx]['race']}, "
                 f"ALL R{legs[weak_idx]['race']}", t3_legs, cost, hp, ev,
                 "Insurance — single in best leg, spread in worst")
            )

    return candidates


def format_selections(legs_meta, selections):
    out = []
    for i, sel in enumerate(selections):
        race_n = legs_meta[i]["race"]
        horses = ", ".join(f"#{p}" for p in sel.keys())
        out.append(f"R{race_n}: {horses}")
    return "  |  ".join(out)


def main():
    ap = argparse.ArgumentParser(description="Multi-race exotic ticket builder (LOCKED v2)")
    ap.add_argument("config_json", help="Path to ticket config JSON")
    args = ap.parse_args()

    with open(args.config_json) as f:
        cfg = json.load(f)

    bet_type = cfg["bet_type"]
    base = cfg["base_amount"]
    budget = cfg["budget"]
    legs = cfg["legs"]
    assert len(legs) == N_LEGS[bet_type], \
        f"{bet_type} requires {N_LEGS[bet_type]} legs but got {len(legs)}"

    print("=" * 78)
    print(f"MULTI-RACE TICKET — {bet_type}  R{legs[0]['race']}-R{legs[-1]['race']}")
    print(f"Base ${base:.2f}  |  Budget cap ${budget:.0f}  |  "
          f"Takeout {TAKEOUT[bet_type]*100:.1f}%")
    print("=" * 78)

    print("\n— Leg tier classification —")
    for L in legs:
        tiers = classify_horses(L["win_probs"])
        print(f"  R{L['race']:<2}  A: {[p for p,_ in tiers['A']] or '—':<14}"
              f" B: {str([p for p,_ in tiers['B']]):<22}"
              f" C: {str([p for p,_ in tiers['C']])}")

    candidates = build_ticket_candidates(legs, bet_type, base, budget)
    if not candidates:
        print(f"\n[!] No tickets fit within budget ${budget}. "
              f"Increase budget or use a smaller base.")
        return

    # Sort by hit probability * ev (proxy for value-adjusted likelihood)
    print("\n— Candidate tickets —\n")
    for name, sel, cost, hp, ev, notes in candidates:
        print(f"▸ {name}")
        print(f"  Selections: {format_selections(legs, sel)}")
        print(f"  Cost: ${cost:.2f}  |  Hit prob: {hp*100:.2f}%  |  "
              f"Expected ROI (rough): {ev*100:+.1f}%")
        print(f"  Notes: {notes}\n")

    # Recommendation: pick the highest hit-prob ticket within budget
    candidates.sort(key=lambda c: -c[3])  # by hit_prob
    best = candidates[0]
    print(f"⭐ RECOMMENDED: {best[0]}")
    print(f"   Reason: Highest hit probability ({best[3]*100:.2f}%) within budget")


if __name__ == "__main__":
    main()
