import { useQuery } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// EEA vs Expert head-to-head strip, pinned at the top of the Analytics page.
// Reads /api/analytics/expert-comparison for the active track (or ALL). The edge
// values are color-coded (green = EEA ahead, red = behind).

export interface ExpertComparison {
  eea: {
    bets: number;
    wins: number;
    itm: number;
    wagered: number;
    payout: number;
    net: number;
    roi: number;
    winPct: number;
  };
  expert: {
    source: string;
    sources: string[];
    races_picked: number;
    graded: number;
    wins: number;
    itm: number;
    win_pct: number;
    itm_pct: number;
    flat_bet_roi: number;
  };
  edge: {
    win_pct_delta: number;
    roi_delta: number;
  };
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}%`;
}
function deltaColor(n: number): string {
  return n >= 0 ? "text-win" : "text-loss";
}

export function ExpertComparisonHeader({
  track = "ALL",
  date,
}: {
  track?: string;
  date?: string;
}) {
  const params = new URLSearchParams();
  if (track) params.set("track", track);
  if (date) params.set("date", date);
  const url = `/api/analytics/expert-comparison?${params.toString()}`;

  const { data, isLoading } = useQuery<ExpertComparison>({ queryKey: [url] });

  if (isLoading || !data) return null;

  const { eea, expert, edge } = data;
  const trackLabel = track === "ALL" ? "ALL TRACKS" : track.toUpperCase();
  const sourceLabel = expert.source || "—";

  return (
    <div
      className="sticky top-0 z-20 rounded-lg border border-gold/20 bg-navy-card/95 backdrop-blur px-4 py-3 antialiased"
      data-testid="expert-comparison-header"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
        <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold whitespace-nowrap">
          {trackLabel}
          {date ? ` · ${date}` : ""}
        </div>

        <div className="flex items-baseline gap-2 text-xs text-silver">
          <span className="text-[10px] uppercase tracking-[0.14em] text-gold font-display font-bold">
            EEA
          </span>
          <span className="tabular-nums font-bold">{eea.wins} W</span>
          <span className="tabular-nums text-muted-brand">· {eea.itm} ITM</span>
          <span className="tabular-nums text-muted-brand">· {eea.bets} bets</span>
          <span className="tabular-nums">{fmtMoney(eea.net)}</span>
          <span className={`tabular-nums font-bold ${deltaColor(eea.roi)}`}>
            ROI {fmtPct(eea.roi)}
          </span>
        </div>

        <div className="flex items-baseline gap-2 text-xs text-silver">
          <span className="text-[10px] uppercase tracking-[0.14em] text-slate-brand font-display font-bold">
            EXPERT
          </span>
          <span className="tabular-nums font-bold">{expert.wins} W</span>
          <span className="tabular-nums text-muted-brand">· {expert.itm} ITM</span>
          <span className="tabular-nums text-muted-brand">
            · {expert.races_picked} races
          </span>
          <span className="text-muted-brand">({sourceLabel})</span>
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-baseline gap-2 text-xs cursor-help"
                data-testid="expert-comparison-edge"
              >
                <span className="text-[10px] uppercase tracking-[0.14em] text-gold-light font-display font-bold">
                  EDGE
                </span>
                <span className={`tabular-nums font-bold ${deltaColor(edge.win_pct_delta)}`}>
                  {fmtPct(edge.win_pct_delta)} win rate
                </span>
                <span className={`tabular-nums font-bold ${deltaColor(edge.roi_delta)}`}>
                  · {fmtPct(edge.roi_delta)} ROI vs flat-bet sim
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              EDGE = EEA win% − expert win%, and EEA ROI − expert flat-bet ROI.
              Expert flat-bet ROI is simulated at a $2 stake / ~$7 average win
              payout until real odds are wired in.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
