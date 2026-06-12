"""Patch card #31 flags to include emoji glyphs on every workout signal type,
so they render both on Jarvis (RaceRow/RaceDetail/Print) and in the printed PDF.

Format: "<emoji> <TYPE> on #<pgm>"
  "🔥 BULLET on #4"
  "⏱️ GATE on #7"
  "⏱️ SHARP on #1"
  "📉 NO WORK on #5"

Preserves any non-workout flags that were there.
"""
import json, base64, urllib.request
from pathlib import Path

BASE = Path('/home/user/workspace/cards_2026-06-12/belmont')
CARD_ID = 31
API = 'https://jarvis.elite-edge-analytics.com'
AUTH = base64.b64encode(b'EliteEdgeAnalytics:Austin08').decode()
PIN = '5811'
HDR = {'Authorization': f'Basic {AUTH}', 'x-admin-pin': PIN,
       'Content-Type': 'application/json'}

def http(m, p, body=None):
    req = urllib.request.Request(API + p, method=m, headers=HDR)
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=30) as r:
        return json.loads(r.read())

GLYPH = {'BULLET': '🔥', 'GATE': '⏱️', 'SHARP': '⏱️', 'NO_WORK': '📉'}
LABEL = {'BULLET': 'BULLET', 'GATE': 'GATE', 'SHARP': 'SHARP', 'NO_WORK': 'NO WORK'}

# Load parsed workouts
eq = json.loads((BASE / 'equibase_with_workouts.json').read_text())

# Get current card to map race numbers -> race ids and merge existing flags
card = http('GET', f'/api/cards/{CARD_ID}/print')
race_id_by_num = {r['raceNumber']: r['id'] for r in card['races']}
existing_by_num = {}
for r in card['races']:
    f = r.get('flags')
    if isinstance(f, str):
        try:
            existing_by_num[r['raceNumber']] = json.loads(f)
        except Exception:
            existing_by_num[r['raceNumber']] = []
    else:
        existing_by_num[r['raceNumber']] = f or []

# Match any flag that looks like a workout flag (with or without emoji prefix)
WORKOUT_TYPES = ('BULLET', 'GATE', 'SHARP', 'NO_WORK', 'NO WORK')
def is_workout_flag(s: str) -> bool:
    # Strip emoji prefix if present
    return any(t in s for t in WORKOUT_TYPES)

for race in eq['races']:
    rn = race['race']
    race_id = race_id_by_num[rn]
    # Collect workout flags per horse with emoji prefix
    new_workout_flags = []
    for h in race['horses']:
        pgm = h['pgm']
        for t in ('BULLET', 'GATE', 'SHARP', 'NO_WORK'):
            if t in h.get('workout_flags', []):
                new_workout_flags.append(f"{GLYPH[t]} {LABEL[t]} on #{pgm}")
    # Keep any non-workout flags
    keep = [f for f in existing_by_num.get(rn, []) if not is_workout_flag(f)]
    merged = keep + new_workout_flags
    http('PATCH', f'/api/races/{race_id}/flags', {'flags': merged})
    print(f"R{rn}: {len(new_workout_flags)} workout flags written")

print("\nDone. Card #31 flags now carry emoji prefixes on every workout signal.")
