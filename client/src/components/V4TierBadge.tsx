import { Target } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// v4 (v4-lock-2026-06-12) tier badge. Distinct from the existing v3.1 TierPill:
// this carries the v4 composite engine's own color language so a v4 read is
// never confused with the live card tier. RECON is the headline "we noticed
// something" stamp — it gets the 🎯 target glyph + a small-ticket tooltip.
export type V4Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

// The per-race grade shape returned by GET /api/cards/:id/v4-grades (client
// view — mirrors the server's V4Grade fields the UI consumes).
export interface V4Grade {
  race: number | string;
  anchorPp: string;
  anchorName: string;
  anchorMl: string;
  tier: V4Tier;
  composite: number;
  confirmsTop3: number;
  recommendation: string;
  fieldSize: number;
}

const TIER_STYLES: Record<V4Tier, string> = {
  SNIPER: "border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-300",
  EDGE: "border-win/40 bg-win/15 text-win",
  DUAL: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  RECON: "border-cyan-400/40 bg-cyan-500/15 text-cyan-300",
  PASS: "border-slate-500/30 bg-slate-500/10 text-muted-brand",
};

export function V4TierBadge({
  tier,
  composite,
  anchorPp,
}: {
  tier: V4Tier;
  composite: number;
  anchorPp?: string;
}) {
  const pill = (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-display font-bold uppercase tabular-nums tracking-[0.12em] ${TIER_STYLES[tier]}`}
      data-testid={`v4-tier-${tier}`}
    >
      {tier === "RECON" && <Target className="h-3 w-3" />}
      v4 {tier}
      {anchorPp ? <span className="opacity-80">#{anchorPp}</span> : null}
      <span className="opacity-70">{composite.toFixed(1)}</span>
    </span>
  );

  if (tier !== "RECON") return pill;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent>Lower conviction — small ticket only</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
