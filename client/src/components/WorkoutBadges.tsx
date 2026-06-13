import type { WorkoutTag } from "@shared/schema";
import { cn } from "@/lib/utils";

// Horse-level workout signal badges. One glyph per tag, color-coded on the
// dashboard's dark/navy theme using existing tokens (no new palette):
//   BULLET  🔥 amber  — fastest work of the day
//   GATE    ⏱ blue    — sharp gate work
//   SHARP   ⚡ green   — generally sharp move
//   NO_WORK 📉 grey   — no workout edge
const TAG_META: Record<WorkoutTag, { glyph: string; label: string; cls: string }> = {
  BULLET: { glyph: "🔥", label: "Bullet workout", cls: "text-gold bg-gold/10 border-gold/30" },
  GATE: { glyph: "⏱", label: "Gate work", cls: "text-sky-400 bg-sky-400/10 border-sky-400/30" },
  SHARP: { glyph: "⚡", label: "Sharp work", cls: "text-win bg-win/10 border-win/30" },
  NO_WORK: {
    glyph: "📉",
    label: "No workout edge",
    cls: "text-muted-brand bg-white/[0.04] border-slate-brand/20",
  },
};

export function WorkoutBadges({
  tags,
  className,
}: {
  tags?: WorkoutTag[] | null;
  className?: string;
}) {
  if (!tags || tags.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)}>
      {tags.map((t) => {
        const meta = TAG_META[t];
        if (!meta) return null;
        return (
          <span
            key={t}
            data-testid={`workout-badge-${t}`}
            className={cn(
              "inline-flex items-center gap-0.5 rounded border px-1 py-0 text-[9px] font-display font-bold uppercase",
              meta.cls,
            )}
            style={{ letterSpacing: "0.06em" }}
            title={meta.label}
            aria-label={meta.label}
          >
            <span aria-hidden>{meta.glyph}</span>
          </span>
        );
      })}
    </span>
  );
}

// Single inline glyph for compact contexts (e.g. RECOMMENDED BETS structure
// strings, where space is tight and color theming is not available). Returns
// the leading tag's glyph or "" if no tags.
export function workoutGlyph(tags?: WorkoutTag[] | null): string {
  if (!tags || tags.length === 0) return "";
  const order: WorkoutTag[] = ["BULLET", "SHARP", "GATE", "NO_WORK"];
  for (const t of order) {
    if (tags.includes(t)) return TAG_META[t]?.glyph ?? "";
  }
  return "";
}
