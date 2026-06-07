import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import type { CardWithRaces } from "@shared/schema";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { Pill } from "@/components/brand/TierPill";
import { RaceRow } from "@/components/RaceRow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Printer, Archive } from "lucide-react";

function StatBox({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="rounded-md border border-gold/10 bg-navy-card px-3 py-2.5 text-center">
      <div className={`text-xl font-display font-black tabular-nums ${accent ?? "text-silver"}`} data-testid={`stat-${label}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[9px] uppercase tracking-[0.14em] text-muted-brand">{label}</div>
    </div>
  );
}

export default function HistoricalCard() {
  const [, params] = useRoute("/historical/:id");
  const id = params?.id;
  const { data: card, isLoading, isError } = useQuery<CardWithRaces>({
    queryKey: ["/api/cards/archived", id],
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (isError || !card) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <Link href="/historical">
          <Button variant="ghost" className="text-gold hover:bg-gold/10 -ml-2" data-testid="button-back-historical">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Historical
          </Button>
        </Link>
        <div className="mt-4 rounded-lg border border-gold/10 bg-navy-card p-8 text-center text-slate-brand">
          That archived card could not be found.
        </div>
      </div>
    );
  }

  const count = (t: string) => card.races.filter((r) => r.tier === t).length;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      {/* Hero strip — read-only */}
      <div className="rounded-xl border border-gold/15 bg-navy-card p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <ScopeLogo size={54} />
            <div>
              <Wordmark />
              <div className="mt-2 flex items-center gap-2">
                <Archive className="h-3.5 w-3.5 text-gold-dark" />
                <span className="text-[10px] uppercase tracking-[0.2em] text-slate-brand">
                  ARCHIVED · {card.track} · {card.date}
                </span>
                <Pill>READ-ONLY</Pill>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/historical">
              <Button
                variant="outline"
                className="border-gold/30 text-gold hover:bg-gold/10"
                data-testid="button-back-historical"
              >
                <ArrowLeft className="h-4 w-4 mr-1.5 shrink-0" /> Back to Historical
              </Button>
            </Link>
            {/* Print stays available so the user can re-print an old card. */}
            <Button
              variant="outline"
              onClick={() => window.open(`#/print/${card.id}`, "_blank")}
              className="border-gold/30 text-gold hover:bg-gold/10"
              data-testid="button-print-picks"
            >
              <Printer className="h-4 w-4 mr-1.5 shrink-0" /> Print Picks
            </Button>
          </div>
        </div>

        {/* Stat strip */}
        <div className="mt-5 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <StatBox label="RACES" value={card.races.length} accent="text-gold-light" />
          <StatBox label="SNIPER" value={count("SNIPER")} accent="text-gold-light" />
          <StatBox label="EDGE" value={count("EDGE")} accent="text-gold" />
          <StatBox label="DUAL" value={count("DUAL")} accent="text-gold-light" />
          <StatBox label="RECON" value={count("RECON")} accent="text-muted-brand" />
          <StatBox label="PASS" value={count("PASS")} accent="text-loss" />
          <StatBox label="CONVICTION" value={card.cardConviction ?? "—"} accent="text-gold" />
        </div>
      </div>

      {/* Race rows — read-only */}
      <div className="mt-4 space-y-3">
        {card.races.map((race) => (
          <RaceRow key={race.id} race={race} readOnly />
        ))}
      </div>
    </div>
  );
}
