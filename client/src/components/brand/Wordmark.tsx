import { cn } from "@/lib/utils";

interface WordmarkProps {
  className?: string;
  showSubtitle?: boolean;
  subtitle?: string;
}

export function Wordmark({
  className,
  showSubtitle = true,
  subtitle = "QUANT-CAPPER · SNIPER SERIES",
}: WordmarkProps) {
  return (
    <div className={cn("flex flex-col leading-none", className)} data-testid="brand-wordmark">
      <span
        className="gold-gradient-text font-display font-black"
        style={{ letterSpacing: "0.25em", fontSize: "0.95rem" }}
      >
        ELITE EDGE ANALYTICS
      </span>
      {showSubtitle && (
        <span
          className="mt-1 text-gold-dark font-display font-semibold"
          style={{ letterSpacing: "0.22em", fontSize: "0.55rem" }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}
