import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { TierPill } from "@/components/brand/TierPill";

// Mirrors GET /api/track-record/summary (server/analytics.ts → buildTrackRecordSummary).
export type Timeframe = "7D" | "30D" | "90D" | "YTD" | "ALL";
export const TIMEFRAMES: Timeframe[] = ["7D", "30D", "90D", "YTD", "ALL"];

export interface TierRecord {
  tier: string;
  wins: number;
  plays: number;
  units: number;
}
export interface TrackRecordSummary {
  timeframe: Timeframe;
  wins: number;
  plays: number;
  winPct: number | null;
  units: number;
  roi: number | null;
  tiers: TierRecord[];
  generatedAt: string;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
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

export function TrackRecordHero({ className }: { className?: string }) {
  const [timeframe, setTimeframe] = useState<Timeframe>("30D");
  const { data, isLoading, isError } = useQuery<TrackRecordSummary>({
    queryKey: [`/api/track-record/summary?timeframe=${timeframe}`],
  });

  const winPct = data?.winPct ?? null;
  const roi = data?.roi ?? null;
  const units = data?.units ?? 0;

  return (
    <div
      className={cn(
        "rounded-xl border border-gold/15 bg-navy-card px-4 py-3.5 sm:px-5 sm:py-4",
        className,
      )}
      data-testid="track-record-hero"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Headline stats */}
        <div className="flex items-center gap-5 sm:gap-8">
          <BigStat
            testId="hero-record"
            value={data ? `${data.wins}/${data.plays}` : "—"}
            label={winPct === null ? "Record" : `Record · ${winPct}% win`}
          />
          <BigStat
            testId="hero-roi"
            value={roi === null ? "—" : `${signed(roi)}%`}
            label="Flat ROI"
            tone={moneyTone(roi)}
          />
          <BigStat
            testId="hero-units"
            value={data ? `${signed(units)}u` : "—"}
            label="Units"
            tone={moneyTone(units)}
          />
        </div>

        {/* Timeframe selector */}
        <div
          className="inline-flex items-center gap-1 rounded-lg border border-gold/15 bg-navy-section p-1"
          role="tablist"
          aria-label="Timeframe"
          data-testid="hero-timeframe"
        >
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              role="tab"
              aria-selected={timeframe === tf}
              onClick={() => setTimeframe(tf)}
              data-testid={`hero-tf-${tf}`}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-display font-bold uppercase tracking-[0.12em] tabular-nums transition-colors",
                timeframe === tf
                  ? "bg-gold text-navy-bg"
                  : "text-slate-brand hover:text-gold-light",
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Tier breakdown mini-row */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-gold/10 pt-3">
        {isLoading && (
          <span className="text-[11px] text-muted-brand" data-testid="hero-loading">
            Loading track record…
          </span>
        )}
        {isError && (
          <span className="text-[11px] text-loss" data-testid="hero-error">
            Track record unavailable
          </span>
        )}
        {data &&
          data.tiers.map((t) => (
            <div key={t.tier} className="flex items-center gap-2" data-testid={`hero-tier-${t.tier}`}>
              <TierPill tier={t.tier} size="sm" />
              <span className="text-[11px] tabular-nums text-silver">
                {t.wins}-{t.plays - t.wins}
              </span>
              <span className={cn("text-[11px] tabular-nums font-semibold", moneyTone(t.units))}>
                {signed(t.units)}u
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
