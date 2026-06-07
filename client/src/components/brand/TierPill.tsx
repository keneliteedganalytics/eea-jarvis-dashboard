import { cn } from "@/lib/utils";
import { tierOf } from "@/lib/tiers";

interface TierPillProps {
  tier: string;
  size?: "sm" | "md";
  className?: string;
}

export function TierPill({ tier, size = "md", className }: TierPillProps) {
  const cfg = tierOf(tier);
  return (
    <span
      data-testid={`pill-tier-${tier}`}
      className={cn(
        "inline-flex items-center rounded-full border font-display font-bold uppercase",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs",
        cfg.text,
        cfg.bg,
        cfg.border,
        className,
      )}
      style={{ letterSpacing: "0.14em" }}
    >
      {cfg.label}
    </span>
  );
}

// Generic brand pill
interface PillProps {
  children: React.ReactNode;
  className?: string;
  variant?: "gold" | "win" | "loss" | "muted";
}

export function Pill({ children, className, variant = "gold" }: PillProps) {
  const variants: Record<string, string> = {
    gold: "text-gold bg-gold/10 border-gold/30",
    win: "text-win bg-win/10 border-win/30",
    loss: "text-loss bg-loss/10 border-loss/30",
    muted: "text-muted-brand bg-white/[0.06] border-slate-brand/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-display font-bold uppercase",
        variants[variant],
        className,
      )}
      style={{ letterSpacing: "0.16em" }}
    >
      {children}
    </span>
  );
}
