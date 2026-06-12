#!/usr/bin/env python3
"""
EEA v4 LIVE RATING CLI
======================
Grades a card using the v4-lock-2026-06-12 weights and tier thresholds.

USAGE:
    python3 eea_v4_rate.py <card_data.json> [--out grades.json]
    python3 eea_v4_rate.py --jarvis <card_id>            # pull from Jarvis API
    python3 eea_v4_rate.py --jarvis 31 --out grades.json

INPUT SCHEMAS SUPPORTED:
  1. Belmont-style:   {races: [{raceNumber, runners: [{pgm, brisnet:{prime_power}, equibase:{...}, mlOdds}]}]}
  2. Churchill-style: {races: [{race, horses: [{pgm, brisnet_prime_power, equibase_class_rating, ...}]}]}
  3. Evaluated:       {races: [{race, all_horses: [{pgm, prime_power, class_rating, ...}]}]}

OUTPUT (stdout + optional JSON file):
  Per race: anchor, tier, composite score, bet recommendation, top-3 by composite.

EXIT CODES:
  0 = success
  1 = bad input / missing file
  2 = no races found
"""

import argparse
import json
import sys
from pathlib import Path

VERSION = "v4-lock-2026-06-12"

# Locked weights (normalized, sum=1)
WEIGHTS = {
    "prime": 0.209,
    "class": 0.167,
    "spd3":  0.153,
    "pc3":   0.194,
    "jt":    0.139,
    "ml":    0.139,
}

TIER_COLORS = {
    "SNIPER": "\033[95m",  # magenta
    "EDGE":   "\033[92m",  # green
    "DUAL":   "\033[93m",  # yellow
    "RECON":  "\033[96m",  # cyan
    "PASS":   "\033[90m",  # grey
}
RESET = "\033[0m"


def odds_to_dec(s):
    """Convert '6/5' or '6-5' to decimal payout-per-$1."""
    s = str(s).replace("-", "/")
    if "/" in s:
        try:
            a, b = s.split("/")
            return float(a) / float(b)
        except (ValueError, ZeroDivisionError):
            return 99.0
    try:
        return float(s)
    except ValueError:
        return 99.0


def rank_within(horses, key, reverse=True):
    """Return {pp: rank} with 1=best."""
    sorted_h = sorted(horses, key=lambda h: h.get(key) or 0, reverse=reverse)
    return {h["pp"]: i + 1 for i, h in enumerate(sorted_h)}


def normalize_horse(h):
    """Normalize one horse from any input schema into v4's canonical form."""
    # Brisnet-nested (Belmont card_data.json)
    if "brisnet" in h:
        prime = h["brisnet"].get("prime_power", 0) or 0
        eq = h.get("equibase", {}) or {}
        cls = eq.get("class_rating", 0) or 0
        spd3 = eq.get("spd_avg3", 0) or 0
        pc3 = eq.get("pace_avg3", 0) or 0
        jt = eq.get("jt_pct", "0%") or "0%"
        jt = float(str(jt).rstrip("%")) if jt else 0.0
        ml = h.get("mlOdds", "99-1") or "99-1"
        name = h.get("name", "")
    # Evaluated (6/12 schema)
    elif "post_pos" in h and "horse" in h:
        prime = h.get("prime_power", 0) or 0
        cls = h.get("class_rating", 0) or 0
        spd3 = h.get("spd_avg3", 0) or 0
        pc3 = h.get("pace_avg3", 0) or 0
        jt = h.get("jt_pct", 0) or 0
        ml = h.get("ml_odds", "99/1") or "99/1"
        name = h.get("horse", "")
    # Flat (Churchill card_data.json)
    else:
        prime = h.get("brisnet_prime_power", h.get("prime_power", 0)) or 0
        cls = h.get("equibase_class_rating", h.get("class_rating", 0)) or 0
        spd3 = h.get("equibase_speed_last3", h.get("spd_avg3", 0)) or 0
        pc3 = h.get("equibase_pace_avg_last3", h.get("pace_avg3", 0)) or 0
        jt = h.get("jt_itm_pct", h.get("jt_pct", 0)) or 0
        ml = h.get("ml_odds", "99/1") or "99/1"
        name = h.get("name", h.get("horse", ""))
    pp = h.get("pgm")
    return {
        "pp": str(pp),
        "name": name,
        "prime_power": float(prime),
        "class_rating": float(cls),
        "speed_avg3":  float(spd3),
        "pace_avg3":   float(pc3),
        "jt_pct":      float(jt),
        "ml_odds":     str(ml),
        "ml_dec":      odds_to_dec(ml),
    }


def compute_composite(horses):
    """Return {pp: {composite, ranks}} for every horse in the race."""
    n = len(horses)
    if n == 0:
        return {}
    rk = {
        "prime": rank_within(horses, "prime_power", True),
        "class": rank_within(horses, "class_rating", True),
        "spd3":  rank_within(horses, "speed_avg3", True),
        "pc3":   rank_within(horses, "pace_avg3", True),
        "jt":    rank_within(horses, "jt_pct", True),
        "ml":    rank_within(horses, "ml_dec", False),  # lower decimal = chalk = better
    }
    scores = {}
    for h in horses:
        pp = h["pp"]
        composite = 0.0
        ranks = {}
        for feat, w in WEIGHTS.items():
            r = rk[feat].get(pp, n)
            rank_score = (n - r + 1) / n
            composite += w * rank_score
            ranks[feat] = r
        scores[pp] = {
            "composite": round(composite * 100, 1),
            "ranks": ranks,
            "name": h["name"],
            "ml_odds": h["ml_odds"],
        }
    return scores


def assign_tier(scores):
    """Pick anchor + tier from the composite scores dict."""
    if not scores:
        return None
    sorted_pps = sorted(scores.keys(), key=lambda p: -scores[p]["composite"])
    anchor_pp = sorted_pps[0]
    a = scores[anchor_pp]
    comp = a["composite"]
    rk = a["ranks"]
    confirms = sum(1 for v in rk.values() if v <= 3)

    if comp >= 90 and rk["prime"] == 1 and rk["pc3"] <= 2:
        tier = "SNIPER"
        rec = "Lock anchor. $25 WIN + $20 EXA key over composite top-3."
    elif comp >= 80 and rk["prime"] <= 2:
        tier = "EDGE"
        rec = "Strong anchor. $15 WIN + $10 EXA key over composite top-3."
    elif comp >= 70 and rk["prime"] <= 3:
        tier = "DUAL"
        rec = "Two-horse exotic. $10 EXA box anchor with composite #2. NO WIN."
    elif comp >= 60 or (rk["prime"] <= 3 and confirms >= 2):
        tier = "RECON"
        rec = "RECON STAMP — lower conviction. $2–$5 EXA box only. NO WIN. Watch live odds."
    else:
        tier = "PASS"
        rec = "Skip race. No anchor meets confidence threshold."

    top3 = sorted_pps[:3]
    return {
        "anchor_pp": anchor_pp,
        "anchor_name": a["name"],
        "anchor_ml": a["ml_odds"],
        "tier": tier,
        "composite": comp,
        "confirms_top3": confirms,
        "ranks": rk,
        "recommendation": rec,
        "composite_top3": [
            {"pp": p, "name": scores[p]["name"], "composite": scores[p]["composite"], "ml": scores[p]["ml_odds"]}
            for p in top3
        ],
    }


def grade_card(card_json):
    """Return a list of race grades for an entire card."""
    races = card_json.get("races", [])
    out = []
    for r in races:
        rn = r.get("raceNumber") or r.get("race")
        raw_horses = r.get("runners") or r.get("horses") or r.get("all_horses") or []
        if not raw_horses:
            out.append({
                "race": rn, "error": "no horses in race data",
                "anchor_pp": None, "tier": "PASS",
            })
            continue
        horses = [normalize_horse(h) for h in raw_horses]
        scores = compute_composite(horses)
        tier = assign_tier(scores)
        if tier is None:
            out.append({"race": rn, "error": "scoring failed", "tier": "PASS"})
            continue
        tier["race"] = rn
        tier["field_size"] = len(horses)
        tier["distance"] = r.get("distance") or r.get("distance_label")
        tier["surface"] = r.get("surface")
        tier["post_time"] = r.get("postTime") or r.get("post_time")
        out.append(tier)
    return out


def print_grades(grades, track=None, date=None):
    print()
    if track or date:
        print(f"{'=' * 80}")
        print(f"{'EEA v4 LIVE RATING — ' + (track or '') + ' ' + (date or ''):^80}")
        print(f"{'(weights ' + VERSION + ')':^80}")
        print(f"{'=' * 80}")
    print()
    print(f"{'R':<3} {'Anchor':<22} {'Tier':<7} {'Comp':>6} {'ML':<8} {'Top-3 by composite':<40}")
    print("-" * 95)
    for g in grades:
        if "error" in g:
            print(f"{g['race']:<3} {'(' + g['error'] + ')':<70}")
            continue
        tier = g["tier"]
        color = TIER_COLORS.get(tier, "")
        anchor = f"#{g['anchor_pp']} {g['anchor_name'][:18]}"
        top3 = " / ".join(f"#{t['pp']}" for t in g["composite_top3"])
        print(f"{g['race']:<3} {anchor:<22} {color}{tier:<7}{RESET} {g['composite']:>6.1f} {g['anchor_ml']:<8} {top3:<40}")
        print(f"     └ {g['recommendation']}")
    print()
    # Tier summary
    counts = {}
    for g in grades:
        t = g.get("tier", "PASS")
        counts[t] = counts.get(t, 0) + 1
    print("Tier breakdown:  " + "  ".join(f"{t}={counts.get(t,0)}" for t in ["SNIPER","EDGE","DUAL","RECON","PASS"]))


def fetch_from_jarvis(card_id):
    """Pull a card from the Jarvis API."""
    import urllib.request, base64, urllib.error
    url = f"https://jarvis.elite-edge-analytics.com/api/cards/{card_id}"
    creds = base64.b64encode(b"EliteEdgeAnalytics:Austin08").decode()
    req = urllib.request.Request(url, headers={
        "Authorization": f"Basic {creds}",
        "x-admin-pin": "5811",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(f"Jarvis API error: HTTP {e.code} {e.reason}", file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(description="EEA v4 live card rating")
    p.add_argument("card_file", nargs="?", help="Path to card_data.json")
    p.add_argument("--jarvis", type=int, help="Pull card by ID from Jarvis API")
    p.add_argument("--out", help="Write grades to this JSON file")
    p.add_argument("--quiet", action="store_true", help="Suppress pretty output")
    args = p.parse_args()

    if args.jarvis is not None:
        card = fetch_from_jarvis(args.jarvis)
        track = card.get("track") or f"card_{args.jarvis}"
        date = card.get("date") or ""
    elif args.card_file:
        path = Path(args.card_file)
        if not path.exists():
            print(f"File not found: {path}", file=sys.stderr)
            sys.exit(1)
        card = json.load(open(path))
        track = card.get("track") or path.stem
        date = card.get("date") or ""
    else:
        p.print_help()
        sys.exit(1)

    grades = grade_card(card)
    if not grades:
        print("No races found in card", file=sys.stderr)
        sys.exit(2)

    if not args.quiet:
        print_grades(grades, track=track, date=date)

    if args.out:
        Path(args.out).write_text(json.dumps({
            "version": VERSION,
            "track": track,
            "date": date,
            "weights": WEIGHTS,
            "grades": grades,
        }, indent=2, default=str))
        if not args.quiet:
            print(f"\nWrote: {args.out}")


if __name__ == "__main__":
    main()
