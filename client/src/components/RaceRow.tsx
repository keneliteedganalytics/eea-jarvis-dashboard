import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import type { RaceWithResult } from "@shared/schema";
import { TierPill } from "@/components/brand/TierPill";
import { WeatherChip } from "@/components/WeatherChip";
import { PickCell } from "@/components/PickCell";
import { tierOf } from "@/lib/tiers";
import { parseFlags } from "@/lib/parseFlags";
import { useJarvis } from "@/lib/jarvis";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Play, Flag, RefreshCw, Trash2 } from "lucide-react";

function ResultStrip({ race }: { race: RaceWithResult }) {
  if (!race.result) return null;
  const order = JSON.parse(race.result.finishOrder) as string[];
  const items = [
    { k: "WIN", hit: race.result.winHit },
    { k: "PLACE", hit: race.result.placeHit },
    { k: "SHOW", hit: race.result.showHit },
    { k: "4TH", hit: race.result.fourthHit },
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]" data-testid={`result-strip-${race.raceNumber}`}>
      <span className="uppercase tracking-[0.14em] text-gold-dark font-display font-bold">Final {order.join("-")}</span>
      {items.map((it) => (
        <span
          key={it.k}
          className={`inline-flex items-center gap-0.5 ${it.hit ? "text-win" : "text-loss"}`}
        >
          {it.k} {it.hit ? "✅" : "❌"}
        </span>
      ))}
    </div>
  );
}

// Shared race row used by both the live "Today's Card" view and the read-only
// Historical card detail. When `readOnly` is set the per-race Jarvis brief
// button is hidden and the race-detail links are inert (archived cards have no
// live /race/:n route).
export function RaceRow({
  race,
  cardId,
  readOnly = false,
}: {
  race: RaceWithResult;
  /**
   * The owning card id. When provided, the race-detail link is scoped to this
   * specific card (/race/:cardId/:n) so multi-track days resolve to the right
   * race instead of always falling through to the backend's "latest" card.
   */
  cardId?: number;
  readOnly?: boolean;
}) {
  const cfg = tierOf(race.tier);
  const jarvis = useJarvis();
  const { toast } = useToast();
  const flags = parseFlags(race.flags);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
  };

  // PR #44: pull this race's official result from OTB on demand.
  const refreshOtb = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/races/${race.id}/auto-grade`, {});
      return res.json() as Promise<{ graded: boolean; reason?: string }>;
    },
    onSuccess: (data) => {
      invalidate();
      toast(
        data.graded
          ? { title: `R${race.raceNumber} graded`, description: "Pulled official result from OTB." }
          : { title: `R${race.raceNumber} not final`, description: data.reason ?? "OTB has no official result yet." },
      );
    },
    onError: (e) => toast({ title: "OTB fetch failed", description: (e as Error).message, variant: "destructive" }),
  });

  // PR #44: clear this race's result row.
  const clearResult = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/races/${race.id}/result`);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: `R${race.raceNumber} cleared`, description: "Result removed." });
    },
    onError: (e) => toast({ title: "Clear failed", description: (e as Error).message, variant: "destructive" }),
  });

  const RaceLink = ({ className, children }: { className?: string; children: React.ReactNode }) =>
    readOnly ? (
      <div className={className}>{children}</div>
    ) : (
      <Link
        href={cardId ? `/race/${cardId}/${race.raceNumber}` : `/race/${race.raceNumber}`}
        className={className}
      >
        {children}
      </Link>
    );

  return (
    <div
      className="group relative flex overflow-hidden rounded-lg border border-gold/10 bg-navy-card hover-elevate"
      data-testid={`race-row-${race.raceNumber}`}
    >
      {/* Tier color strip */}
      <div className={`w-1.5 shrink-0 ${cfg.strip}`} />

      <div className="flex flex-1 flex-col gap-3 p-4 lg:flex-row lg:items-stretch min-w-0">
        {/* Race number + tier */}
        <RaceLink className="flex shrink-0 flex-row lg:flex-col items-center lg:items-start gap-2 lg:w-24">
          <div className="font-display font-black text-xl text-gold-light tabular-nums leading-none">
            R{race.raceNumber}
          </div>
          <TierPill tier={race.tier} size="sm" />
          <div className="text-[10px] text-muted-brand tabular-nums">{race.post}</div>
          <WeatherChip weather={race.weather} />
        </RaceLink>

        {/* Middle: conditions / shape / flags / read */}
        <RaceLink className="flex-1 min-w-0 block">
          <div className="text-xs font-display font-bold text-silver truncate">{race.conditions}</div>
          <div className="mt-1 text-[11px] text-slate-brand line-clamp-2">{race.shape}</div>
          {flags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {flags.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 rounded border border-loss/30 bg-loss/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-loss"
                >
                  <Flag className="h-2.5 w-2.5" /> {f}
                </span>
              ))}
            </div>
          )}
          <ResultStrip race={race} />
        </RaceLink>

        {/* Right: WIN/PLACE/SHOW/4TH columns */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 lg:w-[32rem] shrink-0">
          <PickCell slot="WIN" pgm={race.winPgm} name={race.winName} score={race.winScore} hit={race.result?.winHit} />
          <PickCell slot="PLACE" pgm={race.placePgm} name={race.placeName} score={race.placeScore} hit={race.result?.placeHit} />
          <PickCell slot="SHOW" pgm={race.showPgm} name={race.showName} score={race.showScore} hit={race.result?.showHit} />
          <PickCell slot="4TH" pgm={race.fourthPgm} name={race.fourthName} score={race.fourthScore} hit={race.result?.fourthHit} />
        </div>
      </div>

      {/* Per-race controls — hidden in read-only historical view */}
      {!readOnly && (
        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.preventDefault();
              refreshOtb.mutate();
            }}
            disabled={refreshOtb.isPending}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gold/30 bg-navy-raised text-gold opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gold hover:text-navy-bg focus:opacity-100 disabled:opacity-50"
            data-testid={`button-refresh-otb-${race.raceNumber}`}
            aria-label={`Refresh race ${race.raceNumber} from OTB`}
            title="Refresh result from OTB"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshOtb.isPending ? "animate-spin" : ""}`} />
          </button>
          {race.result && (
            <button
              onClick={(e) => {
                e.preventDefault();
                if (window.confirm(`Clear the result for R${race.raceNumber}?`)) clearResult.mutate();
              }}
              disabled={clearResult.isPending}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-loss/30 bg-navy-raised text-loss opacity-0 transition-opacity group-hover:opacity-100 hover:bg-loss hover:text-navy-bg focus:opacity-100 disabled:opacity-50"
              data-testid={`button-clear-result-${race.raceNumber}`}
              aria-label={`Clear race ${race.raceNumber} result`}
              title="Clear result"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              jarvis.briefViaPost(`/api/jarvis/brief-race/${race.id}`, `Race ${race.raceNumber} briefing`);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gold/30 bg-navy-raised text-gold opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gold hover:text-navy-bg focus:opacity-100"
            data-testid={`button-brief-race-${race.raceNumber}`}
            aria-label={`Brief race ${race.raceNumber}`}
            title="Brief this race"
          >
            <Play className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
