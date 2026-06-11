// Tolerant parse for race.flags, which should be a JSON string-array but for
// some legacy cards was written as plain " | " / "," separated text. Mirrors
// the server's parseStringArrayField; never throws so a malformed value can't
// take down the React tree (see Thistledown card #19).
export function parseFlags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // legacy/plain text: split on common separators
  }
  // Fallback: treat as " | " or "," separated plain-text token list
  return raw.split(/\s*[|,]\s*/).filter(Boolean);
}
