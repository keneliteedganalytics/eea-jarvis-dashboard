import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Card, CardWithRaces, RaceWithResult, Settings } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { TierPill } from "@/components/brand/TierPill";
import { useJarvis } from "@/lib/jarvis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Volume2, Mic, Check, X } from "lucide-react";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Read ?cardId=N off the hash-router URL (e.g. "#/results?cardId=4"). Wouter's
// hash location keeps the query on the hash, so window.location.search is empty.
function cardIdFromHash(): number | null {
  const hash = window.location.hash;
  const q = hash.indexOf("?");
  if (q === -1) return null;
  const id = Number(new URLSearchParams(hash.slice(q + 1)).get("cardId"));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

// Tolerant string-array parse. The API stores flags/finishOrder as JSON strings,
// but a value may arrive null, already-parsed, or malformed (manual-ingest cards,
// future serialization changes). Never throw — a bad field must not blank the page.
function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string" || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Lifetime stats endpoint contract (server/analytics.ts buildLifetimeStats).
interface LifetimeStats {
  totals: {
    cards: number;
    races: number;
    graded: number;
    win: number | null;
    place: number | null;
    show: number | null;
    fourth: number | null;
    exacta: number | null;
    tri: number | null;
    super: number | null;
    itm: number | null;
    flagAccuracy: number | null;
  };
  byTrack: { track: string; cards: number; races: number; graded: number; win: number | null; itm: number | null }[];
}

function pctVal(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gold/10 bg-navy-card px-3 py-2 text-center">
      <div className="text-lg font-display font-black text-gold-light tabular-nums">{value}</div>
      <div className="text-[9px] uppercase tracking-[0.14em] text-muted-brand mt-0.5">{label}</div>
    </div>
  );
}

function ResultEntry({ race, autoRecap }: { race: RaceWithResult; autoRecap: boolean }) {
  const [value, setValue] = useState("");
  const { toast } = useToast();
  const jarvis = useJarvis();

  const submit = useMutation({
    mutationFn: async () => {
      const finishOrder = value.split(/[-\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (finishOrder.length < 2) throw new Error("Enter at least 2 program numbers, e.g. 5-3-1-7");
      await apiRequest("POST", `/api/races/${race.id}/result`, { finishOrder });
      return finishOrder;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] }),
        queryClient.invalidateQueries({ queryKey: [`/api/cards/${race.cardId}`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/stats/lifetime"] }),
      ]);
      toast({ title: `Race ${race.raceNumber} graded`, description: "Result logged." });
      if (autoRecap) {
        jarvis.briefViaPost(`/api/jarvis/recap-race/${race.id}`, `Race ${race.raceNumber} recap`);
      }
    },
    onError: (e: any) => toast({ title: "Invalid", description: e.message, variant: "destructive" }),
  });

  if (race.result) {
    const order = parseStringArray(race.result.finishOrder);
    const grades: [string, boolean | null][] = [
      ["WIN", race.result.winHit], ["PLACE", race.result.placeHit],
      ["SHOW", race.result.showHit], ["4TH", race.result.fourthHit],
    ];
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gold/10 bg-navy-card p-3" data-testid={`result-row-${race.raceNumber}`}>
        <div className="flex items-center gap-2 w-28 shrink-0">
          <span className="font-display font-black text-gold-light tabular-nums">R{race.raceNumber}</span>
          <TierPill tier={race.tier} size="sm" />
        </div>
        <span className="text-xs text-muted-brand tabular-nums">Final {order.join("-")}</span>
        <div className="flex flex-wrap gap-1.5">
          {grades.map(([k, hit]) => (
            <span key={k} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${hit ? "bg-win/10 text-win" : "bg-loss/10 text-loss"}`}>
              {k} {hit ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            </span>
          ))}
          {race.result.exactaHit && <span className="rounded bg-win/10 px-2 py-0.5 text-[10px] text-win uppercase">EXA ✅</span>}
          {race.result.trifectaHit && <span className="rounded bg-win/10 px-2 py-0.5 text-[10px] text-win uppercase">TRI ✅</span>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-gold hover:text-gold-light"
          onClick={() => jarvis.briefViaPost(`/api/jarvis/recap-race/${race.id}`, `Race ${race.raceNumber} recap`)}
          data-testid={`button-recap-${race.raceNumber}`}
        >
          <Volume2 className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gold/10 bg-navy-card p-3" data-testid={`result-row-${race.raceNumber}`}>
      <div className="flex items-center gap-2 w-28 shrink-0">
        <span className="font-display font-black text-gold-light tabular-nums">R{race.raceNumber}</span>
        <TierPill tier={race.tier} size="sm" />
      </div>
      <span className="text-xs text-slate-brand flex-1 min-w-0 truncate">{race.conditions}</span>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="5-3-1-7"
        className="w-32 bg-navy-section border-gold/15 text-silver tabular-nums"
        data-testid={`input-finish-${race.raceNumber}`}
        onKeyDown={(e) => { if (e.key === "Enter") submit.mutate(); }}
      />
      <Button
        size="sm"
        onClick={() => submit.mutate()}
        disabled={submit.isPending}
        className="bg-gold hover:bg-gold-light text-navy-bg"
        data-testid={`button-submit-${race.raceNumber}`}
      >
        Grade
      </Button>
    </div>
  );
}

export default function Results() {
  const { data: settings } = useQuery<Settings>({ queryKey: ["/api/settings"] });
  const { data: lifetime } = useQuery<LifetimeStats>({ queryKey: ["/api/stats/lifetime"] });
  const jarvis = useJarvis();

  // All non-archived cards (active "today" cards + draft/historical manual-ingest
  // cards). Newest date first so the default selection is the most recent card.
  const { data: cardList, isLoading: cardsLoading } = useQuery<Card[]>({ queryKey: ["/api/cards"] });
  const cards = [...(cardList ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1));

  // Selected card id. Initialised from ?cardId=N (set by "Enter Results"), else
  // null — meaning "use the default" (today's card, falling back to most recent).
  const [selectedId, setSelectedId] = useState<number | null>(() => cardIdFromHash());

  // Resolve the effective id once the list loads. Prefer an explicit selection,
  // then today's card, then the most recent card.
  const today = todayIso();
  const defaultCard = cards.find((c) => c.date === today) ?? cards[0];
  const effectiveId =
    (selectedId != null && cards.some((c) => c.id === selectedId) ? selectedId : null) ??
    defaultCard?.id ??
    null;

  const { data: card, isLoading } = useQuery<CardWithRaces>({
    queryKey: [`/api/cards/${effectiveId}`],
    enabled: effectiveId != null,
  });

  // Keep the dropdown in sync if the hash changes while mounted (e.g. arriving
  // from the Manual Ingest modal without a full remount).
  useEffect(() => {
    const onHash = () => {
      const id = cardIdFromHash();
      if (id != null) setSelectedId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!cardsLoading && effectiveId == null && (cardList?.length ?? 0) === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-display font-black text-silver">Scorecard</h1>
        <div className="mt-4 rounded-lg border border-gold/10 bg-navy-card p-6 text-center text-sm text-muted-brand">
          No cards yet. Ingest a card to start grading.
        </div>
      </div>
    );
  }

  if (isLoading || !card) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }

  const isToday = card.date === today;
  const title = isToday ? "Today's Scorecard" : `${card.track} — ${card.date}`;
  const cardStatus = (c: Card): string =>
    c.status === "archived" ? "archived" : c.locked ? "active" : "draft";

  const races = card.races ?? [];
  const withResults = races.filter((r) => r.result);
  const n = withResults.length;
  const sum = (f: (r: RaceWithResult) => boolean | null | undefined) =>
    withResults.filter((r) => f(r)).length;

  const winN = sum((r) => r.result?.winHit);
  const placeN = sum((r) => r.result?.placeHit);
  const showN = sum((r) => r.result?.showHit);
  const fourthN = sum((r) => r.result?.fourthHit);
  const exaN = sum((r) => r.result?.exactaHit);
  const triN = sum((r) => r.result?.trifectaHit);
  const supN = sum((r) => r.result?.superfectaHit);
  const itmTotal = withResults.reduce((a, r) => a + (r.result?.itmCount ?? 0), 0);

  // Flag accuracy across the card
  const flagRows: { flag: string; raceNumber: number; hit: boolean }[] = [];
  for (const r of card.races ?? []) {
    const flags = parseStringArray(r.flags);
    if (!flags.length) continue;
    const hitFlags = r.result ? parseStringArray(r.result.flagsHit) : [];
    for (const f of flags) {
      flagRows.push({ flag: f, raceNumber: r.raceNumber, hit: !!r.result && hitFlags.includes(f) });
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      {cards.length > 0 && (
        <div className="mb-3 max-w-md">
          <Select
            value={String(card.id)}
            onValueChange={(v) => setSelectedId(Number(v))}
          >
            <SelectTrigger
              className="bg-navy-section border-gold/15 text-silver"
              data-testid="results-card-picker"
            >
              <SelectValue placeholder="Select a card" />
            </SelectTrigger>
            <SelectContent>
              {cards.map((c) => {
                const races = c.id === card.id ? card.races?.length ?? 0 : undefined;
                const racesLabel = races === undefined ? "" : `${races} race${races === 1 ? "" : "s"}, `;
                return (
                  <SelectItem key={c.id} value={String(c.id)} data-testid={`results-card-option-${c.id}`}>
                    {c.track} — {c.date} ({racesLabel}{cardStatus(c)})
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-display font-black text-silver" data-testid="results-title">{title}</h1>
        <Button
          onClick={() => jarvis.briefViaPost(`/api/jarvis/summary-card/${card.id}`, `${card.track} card summary`)}
          className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
          data-testid="button-card-summary"
        >
          <Mic className="h-4 w-4 mr-1.5" /> CARD SUMMARY
        </Button>
      </div>

      {/* Running stats */}
      <div className="mt-4 grid grid-cols-4 sm:grid-cols-8 gap-2">
        <StatChip label="WIN" value={pct(winN, n)} />
        <StatChip label="PLACE" value={pct(placeN, n)} />
        <StatChip label="SHOW" value={pct(showN, n)} />
        <StatChip label="4TH" value={pct(fourthN, n)} />
        <StatChip label="EXACTA" value={pct(exaN, n)} />
        <StatChip label="TRI" value={pct(triN, n)} />
        <StatChip label="SUPER" value={pct(supN, n)} />
        <StatChip label="ITM" value={pct(itmTotal, n * 4)} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Per-race entry */}
        <div className="space-y-2.5">
          {races.length === 0 ? (
            <div className="rounded-lg border border-gold/10 bg-navy-card p-6 text-center text-sm text-muted-brand">
              No races on this card yet.
            </div>
          ) : (
            races.map((r) => (
              <ResultEntry key={r.id} race={r} autoRecap={!!settings?.autoRecapEnabled} />
            ))
          )}
        </div>

        {/* Flag accuracy panel */}
        <div className="space-y-4">
          <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Flag Accuracy</div>
            {flagRows.length === 0 ? (
              <div className="text-xs text-muted-brand">No flags raised on this card.</div>
            ) : (
              <div className="space-y-2">
                {flagRows.map((fr, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs" data-testid={`flag-acc-${i}`}>
                    <span className="text-muted-brand tabular-nums w-7">R{fr.raceNumber}</span>
                    <span className="flex-1 text-slate-brand truncate">{fr.flag}</span>
                    <span className={fr.hit ? "text-win" : "text-loss"}>{fr.hit ? "✅" : "❌"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gold/15 bg-navy-section p-4" data-testid="panel-all-time">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">All-Time</div>
            {!lifetime?.totals ? (
              <>
                <div className="text-sm text-silver tabular-nums">—</div>
                <div className="mt-1 text-xs text-muted-brand tabular-nums">Win — · ITM —</div>
              </>
            ) : (
              <>
                <div className="text-sm text-silver tabular-nums" data-testid="all-time-totals">
                  {lifetime.totals.cards} card{lifetime.totals.cards === 1 ? "" : "s"} · {lifetime.totals.races} races · {lifetime.totals.graded} of {lifetime.totals.races} graded
                </div>
                <div className="mt-1 text-xs text-muted-brand tabular-nums">
                  Win {pctVal(lifetime.totals.win)} · ITM {pctVal(lifetime.totals.itm)}
                </div>

                <div className="mt-3 border-t border-gold/10 pt-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">By Track</div>
                  {(lifetime.byTrack ?? []).length === 0 ? (
                    <div className="text-xs text-muted-brand">No cards loaded yet.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {(lifetime.byTrack ?? []).map((t) => (
                        <div key={t.track} className="flex items-center gap-2 text-xs tabular-nums" data-testid={`all-time-track-${t.track}`}>
                          <span className="flex-1 text-slate-brand truncate">{t.track}</span>
                          <span className="text-muted-brand">{t.races} races · {t.graded}/{t.races} graded · {pctVal(t.win)} · {pctVal(t.itm)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
