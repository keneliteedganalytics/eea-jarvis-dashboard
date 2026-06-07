import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { TierPill, Pill } from "@/components/brand/TierPill";
import { PickCell } from "@/components/PickCell";
import { tierOf } from "@/lib/tiers";
import { useJarvis } from "@/lib/jarvis";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Mic, Play, Lock, Check, Flag, RefreshCw, Printer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { UploadCard } from "@/components/UploadCard";

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

function RaceRow({ race }: { race: RaceWithResult }) {
  const cfg = tierOf(race.tier);
  const jarvis = useJarvis();
  const flags = JSON.parse(race.flags || "[]") as string[];

  return (
    <div
      className="group relative flex overflow-hidden rounded-lg border border-gold/10 bg-navy-card hover-elevate"
      data-testid={`race-row-${race.raceNumber}`}
    >
      {/* Tier color strip */}
      <div className={`w-1.5 shrink-0 ${cfg.strip}`} />

      <div className="flex flex-1 flex-col gap-3 p-4 lg:flex-row lg:items-stretch min-w-0">
        {/* Race number + tier */}
        <Link
          href={`/race/${race.raceNumber}`}
          className="flex shrink-0 flex-row lg:flex-col items-center lg:items-start gap-2 lg:w-24"
        >
          <div className="font-display font-black text-xl text-gold-light tabular-nums leading-none">
            R{race.raceNumber}
          </div>
          <TierPill tier={race.tier} size="sm" />
          <div className="text-[10px] text-muted-brand tabular-nums">{race.post}</div>
        </Link>

        {/* Middle: conditions / shape / flags / read */}
        <Link href={`/race/${race.raceNumber}`} className="flex-1 min-w-0 block">
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
        </Link>

        {/* Right: WIN/PLACE/SHOW/4TH columns */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 lg:w-[32rem] shrink-0">
          <PickCell slot="WIN" pgm={race.winPgm} name={race.winName} score={race.winScore} hit={race.result?.winHit} />
          <PickCell slot="PLACE" pgm={race.placePgm} name={race.placeName} score={race.placeScore} hit={race.result?.placeHit} />
          <PickCell slot="SHOW" pgm={race.showPgm} name={race.showName} score={race.showScore} hit={race.result?.showHit} />
          <PickCell slot="4TH" pgm={race.fourthPgm} name={race.fourthName} score={race.fourthScore} hit={race.result?.fourthHit} />
        </div>
      </div>

      {/* Per-race play icon */}
      <button
        onClick={(e) => {
          e.preventDefault();
          jarvis.briefViaPost(`/api/jarvis/brief-race/${race.id}`, `Race ${race.raceNumber} briefing`);
        }}
        className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-gold/30 bg-navy-raised text-gold opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gold hover:text-navy-bg focus:opacity-100"
        data-testid={`button-brief-race-${race.raceNumber}`}
        aria-label={`Brief race ${race.raceNumber}`}
        title="Brief this race"
      >
        <Play className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const LEGEND: { tier: string; desc: string }[] = [
  { tier: "SNIPER", desc: "Top across all 3 sources, ≥4pt class edge" },
  { tier: "EDGE", desc: "Tops with one flag, still rated #1" },
  { tier: "DUAL", desc: "Two horses share the top — exotic structure" },
  { tier: "RECON", desc: "Maiden / weak data, small win play" },
  { tier: "PASS", desc: "Field too wide or no clear top" },
];

export default function Home() {
  const { data: card, isLoading } = useQuery<CardWithRaces>({ queryKey: ["/api/cards/latest"] });
  const jarvis = useJarvis();
  const { toast } = useToast();

  const lockMutation = useMutation({
    mutationFn: async () => {
      if (!card) return;
      await apiRequest("PATCH", `/api/cards/${card.id}`, { locked: true });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] }),
  });

  const fetchNowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/poller/run-now", {});
      return res.json() as Promise<{ ok: boolean; graded: number; skipped: number; cards: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      toast({
        title: data.graded > 0 ? `Graded ${data.graded} race${data.graded === 1 ? "" : "s"}` : "No new results",
        description:
          data.graded > 0
            ? `Pulled fresh results from HorseRacingNation.`
            : `HRN hasn't posted any new finals yet. Try again in a few minutes.`,
      });
    },
    onError: (e) => {
      toast({ title: "Fetch failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  if (isLoading || !card) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-32 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const count = (t: string) => card.races.filter((r) => r.tier === t).length;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      {/* Hero strip */}
      <div className="rounded-xl border border-gold/15 bg-navy-card p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <ScopeLogo size={54} />
            <div>
              <Wordmark />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.2em] text-slate-brand">
                  QUANT-CAPPER · RACE OVERVIEW
                </span>
                <Pill>EE SNIPER SERIES</Pill>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => jarvis.briefViaPost("/api/jarvis/brief-card", `${card.track} card briefing`)}
              className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold tracking-wide"
              data-testid="button-brief-card"
            >
              <Mic className="h-4 w-4 mr-1.5 shrink-0" /> BRIEF ME ON THE CARD
            </Button>
            <Button
              variant="outline"
              onClick={() => window.open("#/print", "_blank")}
              className="border-gold/30 text-gold hover:bg-gold/10"
              data-testid="button-print-picks"
            >
              <Printer className="h-4 w-4 mr-1.5 shrink-0" /> Print Picks
            </Button>
            <Button
              variant="outline"
              onClick={() => fetchNowMutation.mutate()}
              disabled={fetchNowMutation.isPending}
              className="border-gold/30 text-gold hover:bg-gold/10"
              data-testid="button-fetch-now"
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 shrink-0 ${fetchNowMutation.isPending ? "animate-spin" : ""}`} />
              {fetchNowMutation.isPending ? "Fetching…" : "Fetch Results Now"}
            </Button>
            {!card.locked ? (
              <Button
                variant="outline"
                onClick={() => lockMutation.mutate()}
                disabled={lockMutation.isPending}
                className="border-gold/30 text-gold hover:bg-gold/10"
                data-testid="button-lock-card"
              >
                <Lock className="h-4 w-4 mr-1.5 shrink-0" /> Lock the Card
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-win/30 bg-win/10 px-3 py-2 text-xs text-win font-display font-bold">
                <Check className="h-4 w-4" /> CARD LOCKED
              </span>
            )}
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

      {/* Legend + drop zone */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="rounded-lg border border-gold/10 bg-navy-section p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">
            Conviction Tier Legend
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {LEGEND.map((l) => (
              <div key={l.tier} className="flex items-start gap-2">
                <TierPill tier={l.tier} size="sm" />
                <span className="text-[11px] text-slate-brand">{l.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <UploadCard />
      </div>

      {/* Race rows */}
      <div className="mt-4 space-y-3">
        {card.races.map((race) => (
          <RaceRow key={race.id} race={race} />
        ))}
      </div>
    </div>
  );
}
