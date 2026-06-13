#!/usr/bin/env python3
"""
Track Bias Detector — v3.2 component
Computes live post-position and running-style bias from graded races on a card.

USAGE:
    from track_bias_detector import detect_bias
    state = detect_bias(graded_races)
    # state["active"], state["hot_pps"], state["dead_pps"], state["style_bias"]

graded_races: list of dicts like
    {"race_number": 1, "winner_pp": "6", "winner_pace_early": 2.2, "n_runners": 5}
"""

# Tunable thresholds (v3.2 lock candidates)
HOT_PP_THRESHOLD = 0.45            # >= 45% of races won from same PP
MIN_RACES_FOR_SIGNAL = 3           # need 3+ graded results before bias activates
MIN_RACES_FOR_DEAD_PP = 4          # need 4+ before zero-win PPs are "dead"
STYLE_BIAS_THRESHOLD = 0.60        # >= 60% of winners same style = bias

# Running-style classification (matches monte_carlo.py)
PE_FRONT_THRESHOLD = 2.9           # PE < 2.9 = FRONT
PE_STALKER_MAX = 6.0               # 2.9 <= PE <= 6.0 = STALKER, else CLOSER


def classify_style(pe):
    if pe < PE_FRONT_THRESHOLD:
        return "FRONT"
    if pe <= PE_STALKER_MAX:
        return "STALKER"
    return "CLOSER"


def detect_bias(graded_races):
    """
    graded_races: list of dicts with keys:
        - race_number (int)
        - winner_pp (str)              # post position of winner
        - winner_pace_early (float)    # pace_early figure of winner
        - all_pps (list[str])          # all PPs that ran in that race (for dead-PP calc)
    
    Returns:
        {
            "active": bool,
            "n_graded": int,
            "hot_pps": list[str],
            "dead_pps": list[str],
            "pp_win_rates": dict,
            "style_bias": "CLOSER" | "FRONT" | None,
            "style_distribution": dict,
            "confidence": float,
        }
    """
    n = len(graded_races)
    state = {
        "active": False,
        "n_graded": n,
        "hot_pps": [],
        "dead_pps": [],
        "pp_win_rates": {},
        "style_bias": None,
        "style_distribution": {},
        "confidence": 0.0,
    }
    if n < MIN_RACES_FOR_SIGNAL:
        return state

    # PP win rates
    pp_wins = {}
    all_pps_seen = set()
    for g in graded_races:
        wp = str(g["winner_pp"])
        pp_wins[wp] = pp_wins.get(wp, 0) + 1
        for pp in g.get("all_pps", []):
            all_pps_seen.add(str(pp))
    pp_win_rates = {pp: pp_wins.get(pp, 0) / n for pp in all_pps_seen | set(pp_wins.keys())}
    state["pp_win_rates"] = {k: round(v, 3) for k, v in pp_win_rates.items()}

    # Hot PPs
    hot = [pp for pp, rate in pp_win_rates.items() if rate >= HOT_PP_THRESHOLD]
    state["hot_pps"] = sorted(hot, key=lambda p: -pp_win_rates[p])

    # Dead PPs (only meaningful after MIN_RACES_FOR_DEAD_PP)
    if n >= MIN_RACES_FOR_DEAD_PP:
        dead = [pp for pp in all_pps_seen if pp_win_rates.get(pp, 0) == 0]
        state["dead_pps"] = sorted(dead)

    # Style bias
    styles = [classify_style(g["winner_pace_early"]) for g in graded_races]
    dist = {s: styles.count(s) / n for s in set(styles)}
    state["style_distribution"] = {k: round(v, 3) for k, v in dist.items()}
    for s, rate in dist.items():
        if rate >= STYLE_BIAS_THRESHOLD:
            state["style_bias"] = s
            break

    # Active if any signal
    state["active"] = bool(state["hot_pps"] or state["style_bias"])

    # Confidence: weighted by sample size and dominance
    if state["active"]:
        max_pp_rate = max(pp_win_rates.values()) if pp_win_rates else 0
        max_style_rate = max(dist.values()) if dist else 0
        # Cap at 0.85 to never claim 100% certainty
        state["confidence"] = round(min(0.85, (max_pp_rate + max_style_rate) / 2 * (n / 7)), 3)

    return state


def bias_adjustment(horse, bias_state):
    """
    Compute v3.2 bias adjustment for a single horse given current bias state.
    horse dict needs: pp (str), pace_early (float).
    Returns dict of {component: value} for transparency.
    """
    if not bias_state.get("active"):
        return {"total": 0.0, "components": {}}

    adj = {}
    pp = str(horse.get("pp", horse.get("pgm", "")))
    pe = horse.get("pace_early", 5.0)
    style = classify_style(pe)

    # Hot PP bonus
    if pp in bias_state.get("hot_pps", []):
        adj["hot_pp_bonus"] = 1.5
    # Dead PP penalty
    if pp in bias_state.get("dead_pps", []):
        adj["dead_pp_penalty"] = -0.5

    # Style bias
    sb = bias_state.get("style_bias")
    if sb == "CLOSER":
        if style == "CLOSER":
            adj["style_closer_bonus"] = 1.0
        elif style == "FRONT":
            adj["style_front_penalty"] = -1.0
    elif sb == "FRONT":
        if style == "FRONT":
            adj["style_front_bonus"] = 1.0
        elif style == "CLOSER":
            adj["style_closer_penalty"] = -1.0

    total = sum(adj.values())
    return {"total": total, "components": adj}


if __name__ == "__main__":
    # Self-test with Belmont 2026-06-12 R1-R3 data (state at R4 post time)
    import json
    test_graded = [
        {"race_number": 1, "winner_pp": "6", "winner_pace_early": 2.2, "all_pps": ["1","2","3","4","6"]},
        {"race_number": 2, "winner_pp": "1", "winner_pace_early": 4.1, "all_pps": ["1","2","3","4","5","6"]},
        {"race_number": 3, "winner_pp": "6", "winner_pace_early": 3.2, "all_pps": ["1","2","3","4","5","6"]},
    ]
    state = detect_bias(test_graded)
    print("Belmont 2026-06-12 after R1-R3 (state at R4 post time):")
    print(json.dumps(state, indent=2))
    print()

    # State at R5 post time
    test_graded.append({"race_number": 4, "winner_pp": "6", "winner_pace_early": 8.3, "all_pps": ["1","2","3","4","5","6","7"]})
    state = detect_bias(test_graded)
    print("After R1-R4 (state at R5 post time):")
    print(json.dumps(state, indent=2))
    print()

    # State at R7 post time
    test_graded.extend([
        {"race_number": 5, "winner_pp": "1", "winner_pace_early": 5.0, "all_pps": ["1","2","3","4","5","6","7"]},
        {"race_number": 6, "winner_pp": "6", "winner_pace_early": 5.5, "all_pps": ["1","2","3","4","5","6"]},
    ])
    state = detect_bias(test_graded)
    print("After R1-R6 (state at R7 post time):")
    print(json.dumps(state, indent=2))
