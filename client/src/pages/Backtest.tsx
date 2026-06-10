import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import type { BacktestSnapshotSummary, BacktestTierRoi } from "@shared/schema";

// Forward-looking backtest. Snapshots freeze each card's pre-race state; once
// outcomes are recorded, per-tier ROI is computed with no look-ahead leakage.

const TIER_ORDER = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;
// ROI estimates need a floor of settled bets per tier before they mean anything.
const SIGNIFICANCE_THRESHOLD = 30;
const METHODOLOGY_VERSION = "card10-v1";

interface RoiReport {
  methodologyVersion: string;
  cardCount: number;
  raceCount: number;
  settledBetCount: number;
  tiers: Record<string, BacktestTierRoi>;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function winPct(bets: number, wins: number): string {
  if (bets === 0) return "—";
  return `${Math.round((wins / bets) * 100)}%`;
}

export default function Backtest() {
  const { data: snapshots, isLoading: snapsLoading } = useQuery<BacktestSnapshotSummary[]>({
    queryKey: ["/api/backtest/snapshots", `?methodologyVersion=${METHODOLOGY_VERSION}`],
    queryFn: async () => {
      const res = await fetch(
        `/api/backtest/snapshots?methodologyVersion=${METHODOLOGY_VERSION}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
  });
  const { data: roi, isLoading: roiLoading } = useQuery<RoiReport>({
    queryKey: ["/api/backtest/roi", `?methodologyVersion=${METHODOLOGY_VERSION}`],
    queryFn: async () => {
      const res = await fetch(`/api/backtest/roi?methodologyVersion=${METHODOLOGY_VERSION}`);
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
  });

  const cardCount = roi?.cardCount ?? snapshots?.length ?? 0;
  const raceCount = roi?.raceCount ?? (snapshots ?? []).reduce((s, x) => s + x.raceCount, 0);
  const sniperSample = roi?.tiers?.SNIPER?.sampleSize ?? 0;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28" data-testid="page-backtest">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-display font-black text-silver">Backtest</h1>
          <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-brand">
            Methodology{" "}
            <span className="text-gold tabular-nums">{roi?.methodologyVersion ?? METHODOLOGY_VERSION}</span>
            {"  ·  "}
            <span className="text-silver tabular-nums">{cardCount}</span> cards
            {"  ·  "}
            <span className="text-silver tabular-nums">{raceCount}</span> races
          </p>
        </div>
      </div>

      {sniperSample < SIGNIFICANCE_THRESHOLD && (
        <div
          className="mt-4 rounded-md border border-gold/20 bg-gold/[0.06] px-4 py-3 text-xs text-gold-light"
          data-testid="backtest-significance-note"
        >
          ROI estimates require ≥{SIGNIFICANCE_THRESHOLD} settled bets per tier for statistical
          significance — current SNIPER sample:{" "}
          <span className="tabular-nums font-display font-bold">{sniperSample}</span>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-gold/10 bg-navy-card">
        <div className="px-4 py-3 border-b border-gold/10">
          <h2 className="text-sm font-display font-black text-silver uppercase tracking-[0.14em]">
            Per-Tier ROI
          </h2>
        </div>
        {roiLoading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums" data-testid="backtest-roi-table">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-brand">
                  <th className="px-4 py-2 text-left">Tier</th>
                  <th className="px-4 py-2 text-right">Bets</th>
                  <th className="px-4 py-2 text-right">Wins</th>
                  <th className="px-4 py-2 text-right">Win%</th>
                  <th className="px-4 py-2 text-right">Total Staked</th>
                  <th className="px-4 py-2 text-right">Total Returned</th>
                  <th className="px-4 py-2 text-right">ROI%</th>
                </tr>
              </thead>
              <tbody>
                {TIER_ORDER.map((tier) => {
                  const r = roi?.tiers?.[tier];
                  const bets = r?.bets ?? 0;
                  const wins = r?.wins ?? 0;
                  const roiVal = r?.roi ?? null;
                  const roiColor =
                    roiVal == null ? "text-muted-brand" : roiVal >= 0 ? "text-win" : "text-loss";
                  return (
                    <tr
                      key={tier}
                      className="border-t border-gold/[0.06]"
                      data-testid={`backtest-roi-row-${tier}`}
                    >
                      <td className="px-4 py-2 text-left font-display font-bold text-gold-light">
                        {tier}
                      </td>
                      <td className="px-4 py-2 text-right text-silver">{bets}</td>
                      <td className="px-4 py-2 text-right text-silver">{wins}</td>
                      <td className="px-4 py-2 text-right text-silver">{winPct(bets, wins)}</td>
                      <td className="px-4 py-2 text-right text-silver">
                        {money(r?.totalStaked ?? 0)}
                      </td>
                      <td className="px-4 py-2 text-right text-silver">
                        {money(r?.totalReturned ?? 0)}
                      </td>
                      <td className={`px-4 py-2 text-right font-display font-bold ${roiColor}`}>
                        {pct(roiVal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-gold/10 bg-navy-card">
        <div className="px-4 py-3 border-b border-gold/10">
          <h2 className="text-sm font-display font-black text-silver uppercase tracking-[0.14em]">
            Captured Snapshots
          </h2>
        </div>
        {snapsLoading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (snapshots ?? []).length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-brand" data-testid="backtest-empty">
            No snapshots captured for this methodology yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.12em] text-muted-brand">
                  <th className="px-4 py-2 text-left">Card</th>
                  <th className="px-4 py-2 text-left">Track</th>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-right">Races</th>
                  <th className="px-4 py-2 text-right">SNI</th>
                  <th className="px-4 py-2 text-right">EDG</th>
                  <th className="px-4 py-2 text-right">DUA</th>
                  <th className="px-4 py-2 text-right">REC</th>
                  <th className="px-4 py-2 text-right">PASS</th>
                </tr>
              </thead>
              <tbody>
                {(snapshots ?? []).map((s) => (
                  <tr
                    key={s.cardId}
                    className="border-t border-gold/[0.06]"
                    data-testid={`backtest-snapshot-row-${s.cardId}`}
                  >
                    <td className="px-4 py-2 text-left text-gold-light font-display font-bold">
                      #{s.cardId}
                    </td>
                    <td className="px-4 py-2 text-left text-silver">{s.track}</td>
                    <td className="px-4 py-2 text-left text-silver">{s.date}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.raceCount}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.tiersByCount.SNIPER}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.tiersByCount.EDGE}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.tiersByCount.DUAL}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.tiersByCount.RECON}</td>
                    <td className="px-4 py-2 text-right text-silver">{s.tiersByCount.PASS}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
