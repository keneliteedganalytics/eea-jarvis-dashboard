// Post-time extraction, normalization, and time-zone handling shared by every
// ingest path (Equibase Speed Figure Analysis text, Brisnet DRM .DRF, and the
// Brisnet PP PDF). Two values are produced per race:
//
//   • display  — the track-local 12-hour string we store in races.post and show
//                in the UI verbatim (e.g. "12:55 PM"). This preserves the
//                existing look; the client renders races.post directly.
//   • utcIso    — ISO 8601 UTC instant we store in races.post_time_utc for
//                sorting/comparison across tracks in different zones.
//
// Source post times are local-to-track. Tracks map to an IANA zone; we convert
// local wall-clock → UTC using that zone's offset for the card date (DST aware).
//
// The golden rule from the PR spec: NEVER write NULL. If a race has no parseable
// source post time, callers fall back to previous-race + a fixed delta and log a
// structured warning via fallbackPostTime().

// ── Track → IANA time zone ───────────────────────────────────────────────────
// Keyed by both the human track name (Equibase/analyzeCard) and the BRIS track
// code (DRM ingest). Unknown tracks default to America/New_York (the bulk of the
// cards Ken plays are ET ovals); we log when we fall back so the map can grow.
const TRACK_ZONES: Record<string, string> = {
  // Eastern
  "finger lakes": "America/New_York",
  fl: "America/New_York",
  saratoga: "America/New_York",
  sar: "America/New_York",
  belmont: "America/New_York",
  bel: "America/New_York",
  aqueduct: "America/New_York",
  aqu: "America/New_York",
  "churchill downs": "America/New_York",
  cd: "America/New_York",
  gulfstream: "America/New_York",
  gp: "America/New_York",
  keeneland: "America/New_York",
  kee: "America/New_York",
  tampa: "America/New_York",
  tam: "America/New_York",
  parx: "America/New_York",
  prx: "America/New_York",
  monmouth: "America/New_York",
  mth: "America/New_York",
  // Central
  "oaklawn park": "America/Chicago",
  op: "America/Chicago",
  "fair grounds": "America/Chicago",
  fg: "America/Chicago",
  "remington park": "America/Chicago",
  rp: "America/Chicago",
  "lone star": "America/Chicago",
  ls: "America/Chicago",
  canterbury: "America/Chicago",
  cby: "America/Chicago",
  // Mountain
  "sunray park": "America/Denver",
  "sun": "America/Denver",
  "arapahoe park": "America/Denver",
  arp: "America/Denver",
  // Pacific
  "santa anita": "America/Los_Angeles",
  sa: "America/Los_Angeles",
  "del mar": "America/Los_Angeles",
  dmr: "America/Los_Angeles",
  "los alamitos": "America/Los_Angeles",
  lrc: "America/Los_Angeles",
  "golden gate": "America/Los_Angeles",
  gg: "America/Los_Angeles",
};

const DEFAULT_ZONE = "America/New_York";

export function zoneForTrack(track: string): string {
  const key = track.trim().toLowerCase();
  const zone = TRACK_ZONES[key];
  if (zone) return zone;
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "post_time.unknown_track_zone",
      track,
      fallbackZone: DEFAULT_ZONE,
    }),
  );
  return DEFAULT_ZONE;
}

// ── Parsed post time ─────────────────────────────────────────────────────────
export interface PostTime {
  display: string; // "12:55 PM" — track-local, stored in races.post
  utcIso: string; // "2026-06-08T16:55:00.000Z" — stored in races.post_time_utc
}

// Build a 12-hour display string from 24-hour parts.
function toDisplay(hour24: number, minute: number): string {
  const ampm = hour24 >= 12 ? "PM" : "AM";
  let h = hour24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

// Compute the UTC offset (minutes) a given IANA zone has on a given local
// wall-clock instant, using Intl (DST-aware, no external tz library).
function zoneOffsetMinutes(zone: string, utcGuess: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(utcGuess);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Wall-clock the zone shows for this UTC instant, expressed as a UTC instant.
  const asUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour === 24 ? 0 : map.hour,
    map.minute,
    map.second,
  );
  return (asUtc - utcGuess.getTime()) / 60000;
}

// Convert a track-local wall-clock (date + h/m) in `zone` to a UTC ISO string.
// Two-pass to settle DST near transitions: guess with a fixed offset, then
// recompute the offset at that guessed instant and correct.
export function localToUtcIso(
  date: string,
  hour24: number,
  minute: number,
  zone: string,
): string {
  const [y, mo, d] = date.split("-").map(Number);
  const naiveUtc = Date.UTC(y, mo - 1, d, hour24, minute, 0);
  const off1 = zoneOffsetMinutes(zone, new Date(naiveUtc));
  let real = naiveUtc - off1 * 60000;
  const off2 = zoneOffsetMinutes(zone, new Date(real));
  if (off2 !== off1) real = naiveUtc - off2 * 60000;
  return new Date(real).toISOString();
}

// Turn a parsed local h/m into the stored PostTime pair.
function buildPostTime(
  date: string,
  hour24: number,
  minute: number,
  zone: string,
): PostTime {
  return {
    display: toDisplay(hour24, minute),
    utcIso: localToUtcIso(date, hour24, minute, zone),
  };
}

// ── Generic "h:mm AM/PM" parse ───────────────────────────────────────────────
// Returns null when the string carries no recognizable clock time.
export function parseClock(
  raw: string,
): { hour24: number; minute: number } | null {
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(A\.?M\.?|P\.?M\.?)?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (minute > 59) return null;
  const ap = m[3]?.toUpperCase().replace(/\./g, "");
  if (ap === "PM" && hour !== 12) hour += 12;
  else if (ap === "AM" && hour === 12) hour = 0;
  else if (!ap) {
    // No meridiem (common on Brisnet local strings). Thoroughbred cards run
    // afternoon/evening: treat 1–9 as PM, 10–12 as themselves. This matches the
    // Brisnet (h:mm) local field where "12:55" is noon and "1:24" is 13:24.
    if (hour >= 1 && hour <= 9) hour += 12;
  }
  if (hour > 23) return null;
  return { hour24: hour, minute };
}

// ── Equibase: "Post Time: 12:55 PM ET" ───────────────────────────────────────
export function extractEquibasePostTime(
  line: string,
  date: string,
  track: string,
): PostTime | null {
  const m = line.match(/Post\s*Time:?\s*([0-9: ]+(?:[AP]\.?M\.?)?)/i);
  if (!m) return null;
  const clock = parseClock(m[1]);
  if (!clock) return null;
  return buildPostTime(date, clock.hour24, clock.minute, zoneForTrack(track));
}

// ── Brisnet DRM .DRF: trailing zone field "(12:55)/11:55/10:55/ 9:55" ─────────
// The four slash-separated values are ET/CT/MT/PT. The parenthesized first value
// is the track-local post (the DRF wraps the track's own zone in parens). We use
// the parenthesized local value and convert with the track's zone so the stored
// UTC is correct regardless of which slot is the track zone.
export function extractBrisnetDrfPostTime(
  zoneField: string,
  date: string,
  track: string,
): PostTime | null {
  const paren = zoneField.match(/\(\s*(\d{1,2}:\d{2})\s*\)/);
  const local = paren?.[1] ?? zoneField.split("/")[0];
  if (!local) return null;
  const clock = parseClock(local);
  if (!clock) return null;
  return buildPostTime(date, clock.hour24, clock.minute, zoneForTrack(track));
}

// ── Fallback: previous race + delta ──────────────────────────────────────────
// Thoroughbred cards run ~25-30 min apart; 28 is a good default. We add `delta`
// to the previous race's *local* wall clock so the display stays in track time,
// then recompute UTC. Emits a structured warning so we can monitor how often the
// source genuinely lacks a post time.
const DEFAULT_DELTA_MIN = 28;

export function fallbackPostTime(
  prev: PostTime | null,
  date: string,
  track: string,
  raceNumber: number,
  deltaMin: number = DEFAULT_DELTA_MIN,
): PostTime {
  const zone = zoneForTrack(track);
  let display: string;
  let utcIso: string;
  if (prev) {
    const clock = parseClock(prev.display);
    const base = clock ?? { hour24: 12, minute: 0 };
    let total = base.hour24 * 60 + base.minute + deltaMin;
    total = Math.min(total, 23 * 60 + 59);
    const hour24 = Math.floor(total / 60);
    const minute = total % 60;
    display = toDisplay(hour24, minute);
    utcIso = localToUtcIso(date, hour24, minute, zone);
  } else {
    // No previous race either (race 1 missing). Use a conventional first post.
    display = toDisplay(12, 30);
    utcIso = localToUtcIso(date, 12, 30, zone);
  }
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "post_time.fallback",
      track,
      date,
      raceNumber,
      basedOnPrevious: prev != null,
      deltaMin: prev ? deltaMin : null,
      result: display,
    }),
  );
  return { display, utcIso };
}
