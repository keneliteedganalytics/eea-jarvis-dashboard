#!/usr/bin/env python3
"""Backtest v3.2 (with track-bias detector) on Belmont 2026-06-12 R4-R7.

For each race, build the bias state from PRIOR graded races, inject it into
the sim_inputs, then run Monte Carlo. Compare anchor + #6 horse win% to actual.
"""
import json
import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from track_bias_detector import detect_bias, bias_adjustment
import subprocess

# Real Belmont 2026-06-12 graded results
GRADED_RESULTS = [
    {"race_number": 1, "winner_pp": "6", "winner_pace_early": 2.2, "all_pps": ["1","2","3","4","6"]},
    {"race_number": 2, "winner_pp": "1", "winner_pace_early": 4.1, "all_pps": ["1","2","3","4","5","6"]},
    {"race_number": 3, "winner_pp": "6", "winner_pace_early": 3.2, "all_pps": ["1","2","3","4","5","6"]},
    {"race_number": 4, "winner_pp": "6", "winner_pace_early": 8.3, "all_pps": ["1","2","3","4","5","6","7"]},
    {"race_number": 5, "winner_pp": "1", "winner_pace_early": 5.0, "all_pps": ["1","2","3","4","5","6","7"]},
    {"race_number": 6, "winner_pp": "6", "winner_pace_early": 5.5, "all_pps": ["1","2","3","4","5","6"]},
    {"race_number": 7, "winner_pp": "6", "winner_pace_early": 3.5, "all_pps": ["1","2","3","4","5","6","7","8"]},
]

BASE = Path("/home/user/workspace/cards_2026-06-12/belmont/sim_inputs")

# We have sim_inputs for race2, race3, race4 only (didn't sim R5-R7 in live)
# So we can only backtest R4 properly with bias state from R1-R3.
print("=" * 78)
print("v3.2 BACKTEST — Belmont 2026-06-12")
print("=" * 78)

# R4 with bias state from R1-R3
race4_input = json.loads((BASE / "race4.json").read_text())
bias_state = detect_bias(GRADED_RESULTS[:3])  # state as of R4 post time

print(f"\n>>> R4 bias state (after R1-R3):")
print(json.dumps(bias_state, indent=2))

# Inject bias state
race4_input["bias_state"] = bias_state
# Update Princess Ny live odds to actual 6/5
for h in race4_input["horses"]:
    if h["pgm"] == "4":
        h["current_odds"] = "6/5"

# Write to temp + run
tmp = Path("/tmp/race4_v32.json")
tmp.write_text(json.dumps(race4_input, indent=2))

print("\n>>> Running v3.2 sim on R4 with bias state...")
result = subprocess.run(
    ["python3", "/home/user/workspace/handicapping/monte_carlo.py", str(tmp), "--trials", "100000"],
    capture_output=True, text=True, timeout=60
)
print(result.stdout)
if result.returncode != 0:
    print("STDERR:", result.stderr[:1000])
