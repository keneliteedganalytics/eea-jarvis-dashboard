import type { PedigreeSummary, BloodstockConfidence } from "@shared/schema";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Bloodstock (pedigree fitness) chip — PR #16 Phase 2. A single ⚭ glyph plus
// the 0-100 composite, color-coded by confidence on the dashboard's dark/navy
// theme (gold/win/loss tokens — no new palette). Tooltip breaks out the
// sire/dam/dam-sire and the surface/distance/wet sub-fits. When confidence is
// "none" (or the factor never applied) it renders a greyed "⚭ —" with no
// tooltip, so a horse with no recognizable pedigree reads as inert.
const CONFIDENCE: Record<BloodstockConfidence, string> = {
  high: "text-win bg-win/10 border-win/30",
  medium: "text-gold bg-gold/10 border-gold/30",
  low: "text-silver bg-white/[0.06] border-slate-brand/30",
  none: "text-muted-brand bg-white/[0.04] border-slate-brand/20",
};

function fitRow(label: string, v?: number | null) {
  if (v == null) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-brand">{label}</span>
      <span className="tabular-nums">{Math.round(v)}</span>
    </div>
  );
}

export function PedigreeChip({ pedigree }: { pedigree?: PedigreeSummary | null }) {
  const confidence: BloodstockConfidence = pedigree?.confidence ?? "none";
  const inert = !pedigree || confidence === "none" || !pedigree.applied;
  const cfg = CONFIDENCE[inert ? "none" : confidence];

  const chip = (
    <span
      data-testid={`pedigree-chip-${inert ? "none" : confidence}`}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-display font-bold tabular-nums",
        cfg,
        inert && "opacity-60",
      )}
      style={{ letterSpacing: "0.06em" }}
      aria-label="pedigree fitness"
    >
      <span aria-hidden>⚭</span>
      <span>{inert ? "—" : Math.round(pedigree!.composite)}</span>
    </span>
  );

  if (inert) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="text-[11px]">
        <div className="space-y-0.5 min-w-[150px]">
          <div className="font-bold uppercase tracking-wide text-[10px]">
            Pedigree fit · {confidence}
          </div>
          {pedigree!.sireName && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-brand">Sire</span>
              <span className="truncate">{pedigree!.sireName}</span>
            </div>
          )}
          {pedigree!.damName && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-brand">Dam</span>
              <span className="truncate">{pedigree!.damName}</span>
            </div>
          )}
          {pedigree!.damSireName && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-brand">Dam-sire</span>
              <span className="truncate">{pedigree!.damSireName}</span>
            </div>
          )}
          <div className="pt-1 mt-1 border-t border-gold/10 space-y-0.5">
            {fitRow("Surface", pedigree!.surfaceFit)}
            {fitRow("Distance", pedigree!.distanceFit)}
            {fitRow("Wet", pedigree!.wetFit)}
          </div>
          {pedigree!.reasonCodes.length > 0 && (
            <div className="pt-1 mt-1 border-t border-gold/10 text-muted-brand">
              {pedigree!.reasonCodes.join(", ")}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
