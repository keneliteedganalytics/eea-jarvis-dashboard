#!/usr/bin/env python3
"""
EEA v4 RATING SYSTEM — Reverse-engineered from 23 graded races (6/11 + 6/12)
============================================================================

DERIVED FEATURE WEIGHTS (top-3 hit rate over random, n=23):
  prime_power:  1.91×   ← best single predictor
  pace_avg3:    1.78×
  class_rating: 1.53×
  speed_avg3:   1.40×
  ml_odds:      1.27×   ← market signal (weak — chalk failed often)
  jt_pct:       1.27×   ← jockey/trainer combo

COMPOSITE SCORE (0-100):
  Normalize each feature to 0-1 within race, multiply by weight, sum, normalize.
  Top scorer = anchor.

TIER ASSIGNMENT (calibrated to actual win rates from 23-race sample):
  SNIPER — composite ≥ 90 AND prime rank 1 AND pace_avg3 rank ≤ 2
           Expected hit rate: ~55%  →  max ticket: $25 WIN + $20 EXA
  EDGE   — composite ≥ 80 AND prime rank ≤ 2
           Expected hit rate: ~40%  →  max ticket: $15 WIN + $10 EXA
  DUAL   — composite ≥ 70 AND prime rank ≤ 3
           Expected hit rate: ~30%  →  $10 EXA box only, no WIN
  RECON  — composite ≥ 60 OR (prime rank ≤ 3 AND any other top-3 confirm)
           Expected hit rate: ~22%  →  $2-5 EXA box ONLY, no WIN ticket
           "RECON STAMP" = lower-conviction "we noticed something" play
  PASS   — composite < 60 with no confirms
           Skip race entirely

The RECON stamp lets the engine RATE EVERY RACE and surface lower-conviction
plays without forcing a big bet. You decide whether to fire based on live odds
+ how the day is unfolding.
"""

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Load reverse-engineered weights
weights_data = json.load(open("/home/user/workspace/handicapping/calibration/reverse_engineered_weights.json"))
WEIGHTS = weights_data["derived_weights"]

# Normalize weights to sum to 1.0
total_w = sum(WEIGHTS.values())
NORM_W = {k: v/total_w for k, v in WEIGHTS.items()}

# ============================================================================
# COMPOSITE SCORE
# ============================================================================

def rank_within(horses, key, reverse=True):
    """1 = best."""
    valid = [h for h in horses if h.get(key) is not None]
    sorted_h = sorted(valid, key=lambda h: h[key] or 0, reverse=reverse)
    return {h["pp"]: i+1 for i, h in enumerate(sorted_h)}


def odds_to_dec(s):
    s = str(s).replace("-", "/")
    if "/" in s:
        try:
            a, b = s.split("/"); return float(a)/float(b)
        except: return 99.0
    try: return float(s)
    except: return 99.0


def compute_composite(horses):
    """
    For each horse, compute composite score 0-100.
    Each feature is normalized within the race: 1.0 for #1 ranked, 0 for last.
    """
    n = len(horses)
    if n == 0: return {}
    
    # Convert ML odds for ranking (lower decimal = better)
    for h in horses:
        h["_ml_dec"] = odds_to_dec(h.get("ml_odds", "99/1"))
    
    rk_prime = rank_within(horses, "prime_power", reverse=True)
    rk_class = rank_within(horses, "class_rating", reverse=True)
    rk_spd3 = rank_within(horses, "speed_avg3", reverse=True)
    rk_pc3 = rank_within(horses, "pace_avg3", reverse=True)
    rk_jt = rank_within(horses, "jt_pct", reverse=True)
    rk_ml = rank_within(horses, "_ml_dec", reverse=False)
    
    scores = {}
    for h in horses:
        pp = h["pp"]
        rp = rk_prime.get(pp, n); rc = rk_class.get(pp, n); rs = rk_spd3.get(pp, n)
        rpc = rk_pc3.get(pp, n); rj = rk_jt.get(pp, n); rm = rk_ml.get(pp, n)
        # rank_score = (n - rank + 1) / n   →  1.0 for #1, → 0 for last
        ps = (n - rp + 1) / n
        cs = (n - rc + 1) / n
        ss = (n - rs + 1) / n
        pcs = (n - rpc + 1) / n
        js = (n - rj + 1) / n
        ms = (n - rm + 1) / n
        composite = (
            NORM_W["prime"] * ps +
            NORM_W["class"] * cs +
            NORM_W["spd3"] * ss +
            NORM_W["pc3"] * pcs +
            NORM_W["jt"] * js +
            NORM_W["ml"] * ms
        ) * 100
        scores[pp] = {
            "composite": round(composite, 1),
            "ranks": {"prime": rp, "class": rc, "spd3": rs, "pc3": rpc, "jt": rj, "ml": rm},
        }
    return scores


# ============================================================================
# TIER ASSIGNMENT
# ============================================================================

def assign_tier(scores, horses):
    """Given the score dict and horses list, find the top anchor + assign tier."""
    if not scores: return None
    sorted_pps = sorted(scores.keys(), key=lambda p: -scores[p]["composite"])
    anchor_pp = sorted_pps[0]
    a = scores[anchor_pp]
    comp = a["composite"]
    rk = a["ranks"]
    
    # Count "top-3 confirms" (how many features rank top-3)
    confirms = sum(1 for v in rk.values() if v <= 3)
    
    if comp >= 90 and rk["prime"] == 1 and rk["pc3"] <= 2:
        tier = "SNIPER"
        rec = "Lock anchor. Max ticket: $25 WIN + $20 EXA key over top-3 by composite."
    elif comp >= 80 and rk["prime"] <= 2:
        tier = "EDGE"
        rec = "Strong anchor. $15 WIN + $10 EXA key over top-3."
    elif comp >= 70 and rk["prime"] <= 3:
        tier = "DUAL"
        rec = "Two-horse play. $10 EXA box anchor with 2nd-best by composite. NO WIN."
    elif comp >= 60 or (rk["prime"] <= 3 and confirms >= 2):
        tier = "RECON"
        rec = "RECON STAMP — lower conviction. $2-5 EXA box only. Watch live odds."
    else:
        tier = "PASS"
        rec = "Skip race. No anchor meets confidence threshold."
    
    return {
        "anchor_pp": anchor_pp,
        "tier": tier,
        "composite": comp,
        "confirms_top3": confirms,
        "ranks": rk,
        "recommendation": rec,
    }


# ============================================================================
# LOAD ALL 23 RACES (reuse loader from reverse_engineer.py)
# ============================================================================

def load_card(path, runners_key="runners"):
    d = json.load(open(path))
    races = d.get("races", [])
    out = []
    for r in races:
        rn = r.get("raceNumber") or r.get("race")
        horses = r.get(runners_key, []) or r.get("horses", [])
        norm_horses = []
        for h in horses:
            if "brisnet" in h:
                pp = h.get("pgm"); pp_str = str(pp)
                prime = h["brisnet"].get("prime_power", 0)
                eq = h.get("equibase", {})
                cls = eq.get("class_rating", 0); spd3 = eq.get("spd_avg3", 0)
                pc3 = eq.get("pace_avg3", 0); jt = eq.get("jt_pct", "0%")
                jt = float(str(jt).rstrip("%")) if jt else 0
                ml = h.get("mlOdds", "99-1"); name = h.get("name", "")
            else:
                pp = h.get("pgm"); pp_str = str(pp)
                prime = h.get("brisnet_prime_power", 0)
                cls = h.get("equibase_class_rating", 0)
                spd3 = h.get("equibase_speed_last3", 0)
                pc3 = h.get("equibase_pace_avg_last3", 0)
                jt = h.get("jt_itm_pct", 0)
                ml = h.get("ml_odds", "99/1"); name = h.get("name", "")
            norm_horses.append({
                "pp": pp_str, "name": name, "prime_power": prime,
                "class_rating": cls, "speed_avg3": spd3, "pace_avg3": pc3,
                "jt_pct": jt, "ml_odds": ml,
            })
        out.append({"race_num": rn, "horses": norm_horses})
    return out


def load_evaluated(path):
    d = json.load(open(path))
    out = []
    for r in d.get("races", []):
        rn = r.get("race")
        horses = []
        for h in r.get("all_horses", []):
            horses.append({
                "pp": str(h.get("pgm")), "name": h.get("horse", ""),
                "prime_power": h.get("prime_power", 0),
                "class_rating": h.get("class_rating", 0),
                "speed_avg3": h.get("spd_avg3", 0),
                "pace_avg3": h.get("pace_avg3", 0),
                "jt_pct": h.get("jt_pct", 0),
                "ml_odds": "99/1",
            })
        out.append({"race_num": rn, "horses": horses})
    return out


belmont_611 = load_card("/home/user/workspace/cards_2026-06-11/belmont/card_data.json", "runners")
churchill_611 = load_card("/home/user/workspace/cards_2026-06-11/churchill/card_data.json", "horses")
belmont_612 = load_evaluated("/home/user/workspace/cards_2026-06-12/belmont/evaluated.json")

WINNERS = {
    ("belmont", "2026-06-11"): {1:"1", 2:"2", 3:"7", 4:"1", 5:"11", 6:"3", 7:"3", 8:"12"},
    ("churchill", "2026-06-11"): {1:"3", 2:"7", 3:"2", 4:"4", 5:"7", 6:"1", 7:"1", 8:"9"},
    ("belmont", "2026-06-12"): {1:"6", 2:"1", 3:"6", 4:"6", 5:"1", 6:"6", 7:"6"},
}


# ============================================================================
# GRADE EVERY RACE
# ============================================================================

print("=" * 100)
print(f"{'EEA v4 RATING — All 23 Graded Races':^100}")
print(f"{'(weights derived from 6/11 Belmont + 6/11 Churchill + 6/12 Belmont)':^100}")
print("=" * 100)
print(f"\nWeights (normalized to sum=1):  {NORM_W}\n")

def grade_card(card_races, track_label, date_label):
    winners = WINNERS[(track_label, date_label)]
    out = []
    for race in card_races:
        rn = race["race_num"]
        if rn not in winners: continue
        winner_pp = winners[rn]
        horses = race["horses"]
        if not horses or winner_pp not in {h["pp"] for h in horses}: continue
        scores = compute_composite(horses)
        tier_data = assign_tier(scores, horses)
        # Did v4 anchor win?
        anchor_won = (tier_data["anchor_pp"] == winner_pp)
        # If not, did winner come from top-3 by composite?
        sorted_pps = sorted(scores.keys(), key=lambda p: -scores[p]["composite"])
        winner_rank_in_composite = sorted_pps.index(winner_pp) + 1
        out.append({
            "track": track_label, "date": date_label, "race": rn,
            "winner_pp": winner_pp,
            "anchor_pp": tier_data["anchor_pp"],
            "tier": tier_data["tier"],
            "composite": tier_data["composite"],
            "anchor_won": anchor_won,
            "winner_rank_in_composite": winner_rank_in_composite,
            "recommendation": tier_data["recommendation"],
            "confirms": tier_data["confirms_top3"],
        })
    return out


all_graded = (
    grade_card(belmont_611, "belmont", "2026-06-11") +
    grade_card(churchill_611, "churchill", "2026-06-11") +
    grade_card(belmont_612, "belmont", "2026-06-12")
)

# Per-race table
print(f"{'Track':<10} {'Date':<11} {'R':<3} {'Winner':<8} {'Anchor':<8} {'Comp':>6} {'Tier':<7} {'Hit':<5} {'WinRk':<6}")
print("-" * 80)
for r in all_graded:
    hit = "✓ WIN" if r["anchor_won"] else f"#{r['winner_rank_in_composite']}"
    print(f"{r['track']:<10} {r['date']:<11} {r['race']:<3} "
          f"#{r['winner_pp']:<7} #{r['anchor_pp']:<7} "
          f"{r['composite']:>6.1f} {r['tier']:<7} {hit:<5}")

# Hit rate by tier
print()
print("=" * 100)
print("HIT RATE BY TIER (would the v4 anchor have won?)")
print("=" * 100)
tier_stats = {}
for r in all_graded:
    t = r["tier"]
    if t not in tier_stats:
        tier_stats[t] = {"n": 0, "anchor_wins": 0, "top3_finishes": 0}
    tier_stats[t]["n"] += 1
    if r["anchor_won"]: tier_stats[t]["anchor_wins"] += 1
    if r["winner_rank_in_composite"] <= 3: tier_stats[t]["top3_finishes"] += 1

print(f"{'Tier':<8} {'N':>4} {'Anchor Win%':>12} {'Winner in top-3':>18}")
print("-" * 50)
for tier in ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"]:
    s = tier_stats.get(tier)
    if s:
        wr = s["anchor_wins"] / s["n"]
        t3 = s["top3_finishes"] / s["n"]
        print(f"{tier:<8} {s['n']:>4} {wr:>12.0%} {t3:>18.0%}")

# Overall anchor win rate
total_wins = sum(1 for r in all_graded if r["anchor_won"])
overall_wr = total_wins / len(all_graded)
print(f"\nOverall v4 anchor win rate: {overall_wr:.0%} ({total_wins}/{len(all_graded)})")
print(f"Random baseline (avg field ~7): {1/7:.0%}")
print(f"Lift over random: {overall_wr/(1/7):.2f}×")

# Save
out_data = {
    "weights": NORM_W,
    "tier_thresholds": {
        "SNIPER": "composite>=90 AND prime#1 AND pc3<=2",
        "EDGE":   "composite>=80 AND prime<=2",
        "DUAL":   "composite>=70 AND prime<=3",
        "RECON":  "composite>=60 OR (prime<=3 AND 2+ top-3 confirms)",
        "PASS":   "below all",
    },
    "tier_hit_rates": {t: {"n": s["n"], "anchor_win_rate": s["anchor_wins"]/s["n"],
                            "winner_top3_rate": s["top3_finishes"]/s["n"]}
                        for t, s in tier_stats.items()},
    "overall_anchor_win_rate": overall_wr,
    "n_races": len(all_graded),
    "race_grades": all_graded,
}
Path("/home/user/workspace/handicapping/calibration/v4_grades_23race_sample.json").write_text(
    json.dumps(out_data, indent=2, default=str)
)
print(f"\nSaved: /home/user/workspace/handicapping/calibration/v4_grades_23race_sample.json")
