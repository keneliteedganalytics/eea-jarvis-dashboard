// Track → trackside keyframe map for the Daily Show. Each value is a filename
// living under server/assets/show-keyframes/ (dev) or dist/show-keyframes/ (prod
// — the build copies them there since the runtime image omits server/). Drop in
// a new keyframe by adding the file + an entry here.

import fs from "node:fs";
import path from "node:path";

export const TRACK_KEYFRAMES: Record<string, string> = {
  "Saratoga": "saratoga.png",
  "Finger Lakes": "finger-lakes.png",
};

// Used until we generate keyframes for more tracks. Must exist on disk.
export const FALLBACK_KEYFRAME = "saratoga.png";

// Candidate roots in priority order. cwd is the repo root in dev (tsx) and the
// app root in prod (node dist/index.cjs), so both forms resolve correctly.
function keyframeRoots(): string[] {
  return [
    path.join(process.cwd(), "server", "assets", "show-keyframes"),
    path.join(process.cwd(), "dist", "show-keyframes"),
    // Anchor relative to this module too, covering esbuild bundle layouts.
    path.join(__dirname, "show-keyframes"),
    path.join(__dirname, "..", "assets", "show-keyframes"),
  ];
}

function resolveExisting(filename: string): string | null {
  for (const root of keyframeRoots()) {
    const p = path.join(root, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Resolve an absolute path to the keyframe for a track. Unknown tracks WARN and
// fall back — never throws so a new track can never crash the build pipeline.
export function resolveKeyframe(track: string): string {
  const mapped = TRACK_KEYFRAMES[track];
  if (mapped) {
    const found = resolveExisting(mapped);
    if (found) return found;
    console.warn(
      `[show-keyframes] mapped keyframe "${mapped}" for track "${track}" not found on disk; using fallback`,
    );
  } else {
    console.warn(
      `[show-keyframes] no keyframe mapped for track "${track}"; using fallback "${FALLBACK_KEYFRAME}"`,
    );
  }
  const fallback = resolveExisting(FALLBACK_KEYFRAME);
  if (fallback) return fallback;
  // Last resort: return the conventional dev path so callers get a clear ENOENT
  // rather than an empty string. Still no throw.
  return path.join(process.cwd(), "server", "assets", "show-keyframes", FALLBACK_KEYFRAME);
}

// Resolver name the spec/tests reference. Returns the keyframe FILENAME (not the
// absolute path) so it's stable to assert against regardless of cwd.
export function resolveKeyframeFilename(track: string): string {
  return TRACK_KEYFRAMES[track] ?? FALLBACK_KEYFRAME;
}
