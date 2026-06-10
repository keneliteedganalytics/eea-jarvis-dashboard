import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

// Mirrors GET /api/mattice/stats (server/services/mattice-weight.ts → MatticeStats).
export interface MatticeStats {
  n: number;
  systemPickWins: number;
  systemPickPlays: number;
  systemPickWinPct: number | null;
  matticeTopWins: number;
  matticeTopPlays: number;
  matticeTopWinPct: number | null;
  equibaseFavWinPct: number | null;
  roiPct: number | null;
  weightPhase: number;
  phaseLabel: string;
  phaseChangedAt: string | null;
  phaseReason: string | null;
  vetoCount: number;
  generatedAt: string;
}

function pctStr(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}
function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}
function moneyTone(n: number | null): string {
  if (n === null || n === 0) return "text-silver";
  return n > 0 ? "text-win" : "text-loss";
}

function BigStat({
  value,
  label,
  tone,
  testId,
}: {
  value: string;
  label: string;
  tone?: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          "font-display font-black tabular-nums leading-none antialiased text-2xl sm:text-3xl",
          tone ?? "text-gold-light",
        )}
        data-testid={testId}
      >
        {value}
      </span>
      <span className="mt-1 text-[9px] sm:text-[10px] uppercase tracking-[0.16em] text-muted-brand">
        {label}
      </span>
    </div>
  );
}

export function MatticeStatsHero({ className }: { className?: string }) {
  const { data, isLoading, isError } = useQuery<MatticeStats>({
    queryKey: ["/api/mattice/stats"],
  });

  const topPct = data?.matticeTopWinPct ?? null;
  const favPct = data?.equibaseFavWinPct ?? null;
  const roi = data?.roiPct ?? null;
  const beatsBaseline = topPct !== null && favPct !== null && topPct > favPct;

  return (
    <div
      className={cn(
        "rounded-xl border border-gold/15 bg-navy-card px-4 py-3.5 sm:px-5 sm:py-4",
        className,
      )}
      data-testid="mattice-stats-hero"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-5 sm:gap-8">
          <BigStat
            testId="mattice-n"
            value={data ? String(data.n) : "—"}
            label="Graded Races"
          />
          <BigStat
            testId="mattice-topwin"
            value={pctStr(topPct)}
            label="Mattice Top Win%"
            tone={beatsBaseline ? "text-win" : undefined}
          />
          <BigStat
            testId="mattice-favwin"
            value={pctStr(favPct)}
            label="System Win%"
          />
          <BigStat
            testId="mattice-roi"
            value={roi === null ? "—" : `${signed(roi)}%`}
            label="Top-Pick ROI"
            tone={moneyTone(roi)}
          />
        </div>

        {/* Phase badge */}
        <div
          className="inline-flex flex-col items-end gap-0.5 rounded-lg border border-gold/15 bg-navy-section px-3 py-2"
          data-testid="mattice-phase"
        >
          <span className="font-display text-[11px] font-bold uppercase tracking-[0.12em] text-gold-light">
            {data?.phaseLabel ?? "Phase —"}
          </span>
          <span className="text-[10px] tabular-nums text-muted-brand">
            {data ? `${data.vetoCount} veto${data.vetoCount === 1 ? "" : "es"}` : "—"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-gold/10 pt-3">
        {isLoading && (
          <span className="text-[11px] text-muted-brand" data-testid="mattice-loading">
            Loading Mattice overlay…
          </span>
        )}
        {isError && (
          <span className="text-[11px] text-loss" data-testid="mattice-error">
            Mattice overlay unavailable
          </span>
        )}
        {data && (
          <span className="text-[11px] text-silver" data-testid="mattice-phase-reason">
            {data.phaseReason ?? "Phase 1 — overlay logging predictions; weight earned by graded ROI."}
          </span>
        )}
      </div>
    </div>
  );
}
