import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";

interface PickCellProps {
  slot: "WIN" | "PLACE" | "SHOW" | "4TH";
  pgm?: string | null;
  name?: string | null;
  score?: number | null;
  hit?: boolean | null; // grading result, undefined = no result yet
  className?: string;
}

export function PickCell({ slot, pgm, name, score, hit, className }: PickCellProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-gold/10 bg-navy-section px-2.5 py-2 min-w-0",
        slot === "WIN" && "border-gold/25 bg-gold/[0.06]",
        className,
      )}
      data-testid={`pick-${slot.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="text-[9px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">
          {slot}
        </span>
        {hit != null && (
          <span
            className={cn(
              "inline-flex items-center justify-center h-4 w-4 rounded-full",
              hit ? "bg-win/20 text-win" : "bg-loss/20 text-loss",
            )}
            data-testid={`grade-${slot.toLowerCase()}`}
            aria-label={hit ? "hit" : "miss"}
          >
            {hit ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
        <span className="text-gold font-display font-bold text-sm tabular-nums shrink-0">
          #{pgm}
        </span>
        <span
          className="text-silver text-xs leading-tight break-words"
          title={name ?? undefined}
          data-testid={`pick-name-${slot.toLowerCase()}`}
        >
          {name}
        </span>
      </div>
      {score != null && (
        <div className="mt-0.5 text-[11px] text-muted-brand tabular-nums">
          {score.toFixed(1)}
        </div>
      )}
    </div>
  );
}
