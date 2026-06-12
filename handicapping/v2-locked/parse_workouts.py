"""Parse Equibase workout lines and attach BULLET/GATE/SHARP/NO_WORK flags
to each horse in equibase.json (in-place new file: equibase_with_workouts.json).

Workout token format:
  "4 Jun 26 Sar 4F ft :48.40 Breezing 5/8"
  "29 May 26 Sar tt 4F fm :48.85 Breezing g 4/5"   <- 'g' = gate
  ":48.40" or "1:00.96" times.  Rank 1/N = BULLET.

Mapping: workout lines appear in horse order across the PDF, so we zip
them with horses parsed in equibase.json (verified 77==77 for Belmont 6/12).
"""
import re, json
from datetime import date
from pathlib import Path

BASE = Path('/home/user/workspace/cards_2026-06-12/belmont')
CARD_DATE = date(2026, 6, 12)
MONTHS = {'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,
          'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12}

# Each workout starts with: "<dd> <Mon> <yy>"
START = re.compile(r'(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2})\s+')
# Full token capture (track may have 'tr', 'tt', 'o' modifiers; time may be :48.40 or 1:00.96 or :50)
TOKEN = re.compile(
    r'(\d{1,2})\s+(\w{3})\s+(\d{2})\s+'
    r'(\S+(?:\s+\w{1,3})?)\s+'                # track + optional surface modifier
    r'(\d+)F\s+(\w+)\s+'                       # distance + condition (ft/fm/my/sy/gd)
    r'(\d?:?[\d\.]+)\s+'                       # time
    r'(\w+)'                                   # Breezing / Handily
    r'(?:\s+(g))?'                             # optional gate marker
    r'\s+(\d+)/(\d+)'                          # rank/field
)

def to_sec(t: str) -> float:
    t = t.strip()
    if t.startswith(':'):
        return float(t[1:])
    if ':' in t:
        m, s = t.split(':')
        return int(m) * 60 + float(s)
    return float(t)

def parse_workout_line(line: str):
    """Parse one Workout(s): line into list of dicts."""
    s = line.replace('Workout(s):', '').strip()
    # Find all start indices, then match each chunk
    starts = [m.start() for m in START.finditer(s)]
    works = []
    for i, st in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else len(s)
        chunk = s[st:end].strip()
        m = TOKEN.match(chunk)
        if not m:
            # try collapsing whitespace
            chunk2 = re.sub(r'\s+', ' ', chunk)
            m = TOKEN.match(chunk2)
        if not m:
            works.append({'raw': chunk, 'parse_error': True})
            continue
        dd, mon, yy, trk, dist, surf, tm, desc, gate, rank, field = m.groups()
        d = date(2000+int(yy), MONTHS[mon], int(dd))
        days_ago = (CARD_DATE - d).days
        try:
            sec = round(to_sec(tm), 2)
        except Exception:
            sec = None
        dist = int(dist)
        rank = int(rank)
        field = int(field)
        works.append({
            'date': d.isoformat(),
            'daysAgo': days_ago,
            'track': trk.strip(),
            'distF': dist,
            'surface': surf,
            'time': tm,
            'timeSec': sec,
            'desc': desc,
            'gate': bool(gate),
            'rank': rank,
            'field': field,
            'rankStr': f'{rank}/{field}',
            'bullet': rank == 1,
        })
    return works

def flags_for(works):
    fl = set()
    valid = [w for w in works if 'daysAgo' in w]
    # BULLET (last 30 days)
    if any(w.get('bullet') and w['daysAgo'] <= 30 for w in valid):
        fl.add('BULLET')
    # GATE (last 21 days)
    if any(w.get('gate') and w['daysAgo'] <= 21 for w in valid):
        fl.add('GATE')
    # NO_WORK (most recent >= 14 days)
    if valid:
        mn = min(w['daysAgo'] for w in valid)
        if mn >= 14:
            fl.add('NO_WORK')
    # SHARP: 3F<36, 4F<49, 5F<61, 6F<74 — in last 30 days
    for w in valid:
        if w.get('daysAgo', 999) > 30 or w.get('timeSec') is None:
            continue
        d, t = w['distF'], w['timeSec']
        if (d == 3 and t < 36) or (d == 4 and t < 49) or \
           (d == 5 and t < 61) or (d == 6 and t < 74):
            fl.add('SHARP')
            break
    nb = sum(1 for w in valid if w.get('bullet') and w['daysAgo'] <= 30)
    return sorted(fl), nb

# --- Main: zip Workout(s) lines in order with horses ---
txt = (BASE / 'equibase.txt').read_text()
workout_lines = [ln.strip() for ln in txt.splitlines() if ln.strip().startswith('Workout(s):')]

eq = json.loads((BASE / 'equibase.json').read_text())
horses_flat = [(r['race'], h) for r in eq['races'] for h in r['horses']]

assert len(horses_flat) == len(workout_lines), \
    f"Mismatch: {len(horses_flat)} horses vs {len(workout_lines)} workout lines"

stats = {'BULLET': 0, 'GATE': 0, 'SHARP': 0, 'NO_WORK': 0}
for (race, horse), wline in zip(horses_flat, workout_lines):
    works = parse_workout_line(wline)
    flags, nb = flags_for(works)
    horse['workouts'] = works
    horse['workout_flags'] = flags
    horse['bullets_30d'] = nb
    for f in flags:
        stats[f] = stats.get(f, 0) + 1

(BASE / 'equibase_with_workouts.json').write_text(json.dumps(eq, indent=2))
print(f"Parsed {len(workout_lines)} workout lines for {len(horses_flat)} horses")
print(f"Horses with each flag: {stats}")
