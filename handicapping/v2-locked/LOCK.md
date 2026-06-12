# V2 LOCK — Elite Edge Analytics Handicapping Pipeline

**Locked**: 2026-06-12 by Kenneth Young
**Unlock phrase**: `approve v3` (nothing else releases this lock)
**Scope**: Brisnet + Equibase + OTB/TwinSpires last-minute drops grading, workout signal parsing, Jarvis upload, and print PDF generation.

---

## Files in this lock

| File | SHA-256 | Purpose |
|---|---|---|
| `card_ingest_prompt.md` | `5d16a769b6f430396efffee28f487ead05fbb01e56526bbd74b659216469c255` | Master workflow doc — 7-stage pipeline + forbidden-actions list |
| `print_card_from_jarvis.py` | `8274c987989788236dcb1b37db2395eadeecd840176a27b0ee6eaa91a3cc17fb` | CANONICAL print PDF generator (headless Chromium → Jarvis `/#/print`) |
| `parse_workouts.py` | `e60bf1d195f853136556f1e84089705a18cc7bdcb7eba3aa14d50e2251a788b4` | Equibase workout-signal parser (BULLET/GATE/SHARP/NO_WORK) |
| `relock_emoji_flags.py` | `23ddac85e9acd749dfdce71b8a87faec321669071cc1843e28c50c2f828be794` | Per-card flag writer — emits emoji-prefixed workout chips |

---

## Locked emoji vocabulary

- `🔥` U+1F525 — BULLET
- `⏱️` U+23F1 U+FE0F — SHARP **and** GATE (same glyph, two semantics)
- `📉` U+1F4C9 — NO WORK

## Locked flag string format

Stored as JSON array on `races.flags`. Each workout signal:
```
"<emoji> <TYPE> on #<pgm>"
```
Examples: `"🔥 BULLET on #4"`, `"⏱️ SHARP on #7"`, `"⏱️ GATE on #2"`, `"📉 NO WORK on #11"`

Non-workout flags (class drops, hot trainer) coexist without emoji prefix.
Print page joins flags with `, ` between them (`client/src/pages/Print.tsx:146`).

## Locked v2 PP-anchor rules

- Prime Power top-rank = anchor
- Jockey win% = confirmer/rescue
- `[NO WORK]` on anchor = hard veto (demote to next PP rank)
- Pace / Speed-last / JT% = noise on routes
- Surface override for turf routes ≥1M
- Tiers: **SNIPER** (PP #1 + gap≥2.0 + top-2 Jky% + no NO_WORK) · **EDGE** (PP #1 + gap≥1.0 OR tight-gap with anchor top-3 Spd-avg3+Class) · **DUAL** (gap≤1.0 + #2 stronger) · **RECON** · **PASS**

## Locked ticket sizing

TRI Key W/4 preferred. $3 base SNIPER ($36), $2 base EDGE ($24). EXA Box 3 horses only ($12). Win cap $25 unless SNIPER. DUAL = EXA Box 2 at $5 base ($10) + small TRI Key $1 base ($12).

---

## Forbidden actions (drift triggers)

- ❌ Inventing prose templates in `whyText` / `read`
- ❌ Adding tier names or changing tier thresholds
- ❌ Changing emoji glyphs or codepoints
- ❌ Refactoring parsers in a way that changes output schema
- ❌ Switching print PDF renderer away from headless-Chromium Jarvis `/#/print`
- ❌ Omitting OTB/TwinSpires scratch-check before upload
- ❌ Dropping workout signals from the flags array

---

## How to verify the lock at session start

```bash
cd handicapping/v2-locked && sha256sum -c <<'EOF'
5d16a769b6f430396efffee28f487ead05fbb01e56526bbd74b659216469c255  card_ingest_prompt.md
8274c987989788236dcb1b37db2395eadeecd840176a27b0ee6eaa91a3cc17fb  print_card_from_jarvis.py
e60bf1d195f853136556f1e84089705a18cc7bdcb7eba3aa14d50e2251a788b4  parse_workouts.py
23ddac85e9acd749dfdce71b8a87faec321669071cc1843e28c50c2f828be794  relock_emoji_flags.py
EOF
```

Any drift = hash mismatch = stop work and re-sync from this directory.
