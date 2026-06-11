import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { CardWithRaces } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { TierPill, Pill } from "@/components/brand/TierPill";
import { RaceRow } from "@/components/RaceRow";
import { useJarvis } from "@/lib/jarvis";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Mic, Lock, Check, RefreshCw, Printer, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { HostHero } from "@/components/brand/HostHero";
import { TrackRecordHero } from "@/components/TrackRecordHero";
import { MatticeStatsHero } from "@/components/MatticeStatsHero";
import { DraftCardsSection } from "@/components/DraftCardsSection";
import { PullCardModal } from "@/components/PullCardModal";
import { ManualIngestModal } from "@/components/ManualIngestModal";

// PR #44: per-card running bankroll. Color-coded: green > 1000, amber 600–1000,
// red < 600. Polls the ledger; refreshed live by the race-graded SSE event.
function BankrollPill({ cardId }: { cardId: number }) {
  const { data } = useQuery<{ balance: number }>({
    queryKey: ["/api/cards", String(cardId), "bankroll"],
  });
  if (!data) return null;
  const bal = data.balance;
  const tone =
    bal > 1000
      ? "border-win/40 bg-win/10 text-win"
      : bal >= 600
        ? "border-gold/40 bg-gold/10 text-gold"
        : "border-loss/40 bg-loss/10 text-loss";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-display font-bold tabular-nums ${tone}`}
      data-testid="pill-bankroll"
      title="Card bankroll ($1,000 starting)"
    >
      BANKROLL ${bal.toFixed(2)}
    </span>
  );
}

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

// Active card summary as returned by the /api/cards list endpoint.
interface CardListItem {
  id: number;
  track: string;
  date: string;
  status: string;
}

// Today's date as YYYY-MM-DD in the user's racing timezone (America/Boise),
// so the track switcher matches cards stored as MDT calendar dates.
function boiseToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Boise",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const LEGEND: { tier: string; desc: string }[] = [
  { tier: "SNIPER", desc: "Top across all 3 sources, ≥4pt class edge" },
  { tier: "EDGE", desc: "Tops with one flag, still rated #1" },
  { tier: "DUAL", desc: "Two horses share the top — exotic structure" },
  { tier: "RECON", desc: "Maiden / weak data, small win play" },
  { tier: "PASS", desc: "Field too wide or no clear top" },
];

// Workout glyphs that appear in race reads/summaries. Documented here and on
// the printable bet card so the symbols aren't undefined in the UI.
const WORKOUT_LEGEND: { glyph: string; label: string }[] = [
  { glyph: "🔥", label: "Bullet workout" },
  { glyph: "⏱️", label: "Gate work" },
  { glyph: "📉", label: "No workout edge" },
];

export default function Home() {
  // When >1 active card exists for today, the track switcher sets this to view
  // a specific card; undefined means "show the latest card" (default behavior).
  const [selectedCardId, setSelectedCardId] = useState<number | undefined>(undefined);

  const { data: activeCards = [] } = useQuery<CardListItem[]>({ queryKey: ["/api/cards"] });
  const today = boiseToday();
  const todaysCards = activeCards.filter((c) => c.status === "active" && c.date === today);
  const showSwitcher = todaysCards.length > 1;

  const activeCardKey = selectedCardId ? ["/api/cards", selectedCardId] : ["/api/cards/latest"];
  const { data: card, isLoading } = useQuery<CardWithRaces>({ queryKey: activeCardKey });
  const jarvis = useJarvis();
  const { toast } = useToast();

  const lockMutation = useMutation({
    mutationFn: async () => {
      if (!card) return;
      await apiRequest("PATCH", `/api/cards/${card.id}`, { locked: true });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: activeCardKey }),
  });

  const fetchNowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/poller/run-now", {});
      return res.json() as Promise<{ ok: boolean; graded: number; skipped: number; cards: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: activeCardKey });
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

  if (!card) {
    return (
      <div className="p-4 sm:p-6 max-w-[1100px] mx-auto pb-28">
        <TrackRecordHero />
        <div className="mt-4 flex justify-end gap-2">
          <ManualIngestModal />
          <PullCardModal />
        </div>
        <DraftCardsSection />
        <div className="mt-4">
          <HostHero />
        </div>
      </div>
    );
  }

  const count = (t: string) => card.races.filter((r) => r.tier === t).length;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      {/* Analytics-led hero — overall record + ROI + units, by timeframe */}
      <TrackRecordHero className="mb-4" />

      {/* Mattice 5-factor overlay — running record + current weight phase */}
      <MatticeStatsHero className="mb-4" />

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
            <BankrollPill cardId={card.id} />
            <Button
              onClick={() => jarvis.briefViaPost("/api/jarvis/brief-card", `${card.track} card briefing`)}
              className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold tracking-wide"
              data-testid="button-brief-card"
            >
              <Mic className="h-4 w-4 mr-1.5 shrink-0" /> BRIEF ME ON THE CARD
            </Button>
            {todaysCards.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="border-gold/30 text-gold hover:bg-gold/10"
                    data-testid="button-print-picks"
                  >
                    <Printer className="h-4 w-4 mr-1.5 shrink-0" /> Print Picks
                    <ChevronDown className="h-4 w-4 ml-1.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {todaysCards.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => window.open(`#/print/${c.id}`, "_blank")}
                      data-testid={`print-card-${c.id}`}
                    >
                      {c.track}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="outline"
                onClick={() => window.open("#/print", "_blank")}
                className="border-gold/30 text-gold hover:bg-gold/10"
                data-testid="button-print-picks"
              >
                <Printer className="h-4 w-4 mr-1.5 shrink-0" /> Print Picks
              </Button>
            )}
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
            <ManualIngestModal />
            <PullCardModal />
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

      {/* Legend */}
      <div className="mt-4">
        <div className="rounded-lg border border-gold/10 bg-navy-section p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">
            Conviction Tier Legend
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {LEGEND.map((l) => (
              <div key={l.tier} className="flex items-start gap-2">
                <TierPill tier={l.tier} size="sm" />
                <span className="text-[11px] text-slate-brand">{l.desc}</span>
              </div>
            ))}
          </div>

          {/* Workout signal glyphs used in race reads/summaries */}
          <div className="mt-4 border-t border-gold/10 pt-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">
              Workout Signals
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {WORKOUT_LEGEND.map((w) => (
                <span key={w.label} className="inline-flex items-center gap-1.5 text-[11px] text-slate-brand">
                  <span className="text-sm leading-none">{w.glyph}</span>
                  {w.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Draft cards awaiting review (above the active card's races) */}
      <DraftCardsSection />

      {/* Track switcher — only when more than one active card exists today */}
      {showSwitcher && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">
            Today's Cards
          </div>
          <div className="flex flex-wrap gap-2">
            {todaysCards.map((c) => {
              const selected = selectedCardId == null ? c.id === card.id : c.id === selectedCardId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCardId(c.id)}
                  data-testid={`chip-card-${c.id}`}
                  className="focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 rounded-full"
                >
                  <Pill variant={selected ? "gold" : "muted"}>{c.track}</Pill>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Race rows */}
      <div className="mt-4 space-y-3">
        {card.races.map((race) => (
          <RaceRow key={race.id} race={race} />
        ))}
      </div>
    </div>
  );
}
