import { useParams, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { CardWithRaces, RaceWithResult } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { TierPill } from "@/components/brand/TierPill";
import { PedigreeChip } from "@/components/PedigreeChip";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { useJarvis } from "@/lib/jarvis";
import { tierOf } from "@/lib/tiers";
import { parseFlags } from "@/lib/parseFlags";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Mic, Flag, Check, X, Save, Ban, RotateCcw } from "lucide-react";

const PACE_LANES = ["E", "E/P", "P", "S"];

function PaceDiagram({ race }: { race: RaceWithResult }) {
  // Simplified pace shape: distribute the 4 picks across lanes by a heuristic
  // (win=E/P, place=P, show=S, fourth=E). Real data would override this.
  const markers: Record<string, { pgm: string; name: string }[]> = {
    "E": [{ pgm: race.fourthPgm ?? "", name: race.fourthName ?? "" }],
    "E/P": [{ pgm: race.winPgm ?? "", name: race.winName ?? "" }],
    "P": [{ pgm: race.placePgm ?? "", name: race.placeName ?? "" }],
    "S": [{ pgm: race.showPgm ?? "", name: race.showName ?? "" }],
  };
  return (
    <div className="space-y-2.5">
      {PACE_LANES.map((lane, i) => (
        <div key={lane} className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[10px] uppercase tracking-wider text-gold-dark font-display font-bold text-right">
            {lane}
          </span>
          <div className="relative h-7 flex-1 rounded bg-navy-section overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-gold/20 to-transparent"
              style={{ width: `${85 - i * 18}%` }}
            />
            {markers[lane].map((m) =>
              m.pgm ? (
                <span
                  key={m.pgm}
                  className="absolute top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded bg-gold/15 border border-gold/30 px-1.5 py-0.5 text-[10px] text-gold tabular-nums"
                  style={{ left: `${10 + i * 12}%` }}
                >
                  #{m.pgm}
                </span>
              ) : null,
            )}
          </div>
        </div>
      ))}
      <div className="text-[10px] text-muted-brand pt-1">
        Pace data simplified — drop full PPs to enable precise running-style placement.
      </div>
    </div>
  );
}

function PickEditor({ race, locked }: { race: RaceWithResult; locked: boolean }) {
  const { toast } = useToast();
  const [why, setWhy] = useState(race.whyText ?? "");
  const [pace, setPace] = useState(race.paceText ?? "");

  useEffect(() => {
    setWhy(race.whyText ?? "");
    setPace(race.paceText ?? "");
  }, [race.id]);

  const save = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/races/${race.id}`, { whyText: why, paceText: pace });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      toast({ title: "Saved", description: `Notes for Race ${race.raceNumber} saved.` });
    },
  });

  const scratched = new Set<string>(
    (() => {
      try {
        const j = JSON.parse(race.scratchedPgms ?? "[]");
        return Array.isArray(j) ? j.map(String) : [];
      } catch {
        return [];
      }
    })(),
  );

  const scratch = useMutation({
    mutationFn: async (vars: { pgm: string; scratched: boolean }) => {
      await apiRequest("POST", `/api/races/${race.id}/scratch`, vars);
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      toast({
        title: vars.scratched ? "Horse scratched" : "Horse reinstated",
        description: `Race ${race.raceNumber} re-tiered · #${vars.pgm}.`,
      });
    },
    onError: (e: Error) => toast({ title: "Scratch failed", description: e.message, variant: "destructive" }),
  });

  const picks = [
    { slot: "WIN", pgm: race.winPgm, name: race.winName, score: race.winScore, hit: race.result?.winHit },
    { slot: "PLACE", pgm: race.placePgm, name: race.placeName, score: race.placeScore, hit: race.result?.placeHit },
    { slot: "SHOW", pgm: race.showPgm, name: race.showName, score: race.showScore, hit: race.result?.showHit },
    { slot: "4TH", pgm: race.fourthPgm, name: race.fourthName, score: race.fourthScore, hit: race.result?.fourthHit },
  ];

  return (
    <div className="space-y-3">
      {picks.map((p) => {
        const isScratched = !!p.pgm && scratched.has(p.pgm);
        return (
        <div key={p.slot} className={`rounded-lg border p-3 ${isScratched ? "border-loss/25 bg-navy-card/50 opacity-60" : "border-gold/15 bg-navy-card"}`} data-testid={`detail-pick-${p.slot}`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">{p.slot}</span>
            {p.hit != null && (
              <span className={`text-xs ${p.hit ? "text-win" : "text-loss"}`}>{p.hit ? "✅ HIT" : "❌ MISS"}</span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={`font-display font-black text-lg tabular-nums ${isScratched ? "text-loss line-through" : "text-gold-light"}`}>#{p.pgm}</span>
            <span className={`text-sm truncate ${isScratched ? "text-muted-brand line-through" : "text-silver"}`}>{p.name}</span>
            {p.pgm && !isScratched && (
              <span className="self-center">
                <PedigreeChip pedigree={race.pedigree?.[p.pgm]} />
              </span>
            )}
            <span className="ml-auto text-gold font-display font-bold tabular-nums">{p.score?.toFixed(1)}</span>
          </div>
          {p.pgm && !locked && (
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={scratch.isPending}
                onClick={() => scratch.mutate({ pgm: p.pgm!, scratched: !isScratched })}
                className={`h-7 px-2 text-[11px] ${isScratched ? "border-gold/30 text-gold hover:bg-gold/10" : "border-loss/30 text-loss hover:bg-loss/10"}`}
                data-testid={`button-scratch-${p.slot}`}
              >
                {isScratched ? <><RotateCcw className="h-3 w-3 mr-1" /> Un-scratch</> : <><Ban className="h-3 w-3 mr-1" /> Scratch</>}
              </Button>
            </div>
          )}
        </div>
        );
      })}

      <div className="rounded-lg border border-gold/10 bg-navy-section p-3 space-y-3">
        <div>
          <label className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">Why</label>
          <Textarea
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Why is this the top pick?"
            className="mt-1 bg-navy-card border-gold/15 text-silver min-h-[70px]"
            data-testid="input-why"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">Pace Matchup</label>
          <Textarea
            value={pace}
            onChange={(e) => setPace(e.target.value)}
            placeholder="How does the pace set up?"
            className="mt-1 bg-navy-card border-gold/15 text-silver min-h-[70px]"
            data-testid="input-pace"
          />
        </div>
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="bg-gold hover:bg-gold-light text-navy-bg"
          data-testid="button-save-notes"
        >
          <Save className="h-4 w-4 mr-1.5" /> Save Notes
        </Button>
      </div>
    </div>
  );
}

function RetierHistory({ race }: { race: RaceWithResult }) {
  const events = (race.events ?? []).filter((e) => e.type === "SCRATCH" || e.type === "UNSCRATCH");
  if (events.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-gold/10 bg-navy-section p-3" data-testid="retier-history">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">Re-tier History</div>
      <div className="space-y-2">
        {events.map((e) => {
          let p: { scratched?: string[]; reTieredAt?: string; oldPicks?: Record<string, string | null>; newPicks?: Record<string, string | null> } = {};
          try { p = JSON.parse(e.payloadJson || "{}"); } catch { p = {}; }
          const fmt = (x?: string | null) => (x ? `#${x}` : "—");
          const shifted =
            p.oldPicks && p.newPicks
              ? `WIN ${fmt(p.oldPicks.win)}→${fmt(p.newPicks.win)} · PL ${fmt(p.oldPicks.place)}→${fmt(p.newPicks.place)} · SH ${fmt(p.oldPicks.show)}→${fmt(p.newPicks.show)}`
              : "";
          const when = p.reTieredAt ?? e.createdAt;
          const isUnscratch = e.type === "UNSCRATCH";
          return (
            <div key={e.id} className="text-[11px] text-slate-brand tabular-nums">
              <div className="flex items-center gap-1.5">
                {isUnscratch ? <RotateCcw className="h-3 w-3 text-gold shrink-0" /> : <Ban className="h-3 w-3 text-loss shrink-0" />}
                <span className="text-silver">
                  {isUnscratch
                    ? `Reinstated · ${p.scratched && p.scratched.length ? `still scratched ${p.scratched.map((s) => `#${s}`).join(", ")}` : "field restored"}`
                    : `Scratched ${p.scratched && p.scratched.length ? p.scratched.map((s) => `#${s}`).join(", ") : "—"}`}
                </span>
                <span className="ml-auto text-muted-brand">{new Date(when).toLocaleString()}</span>
              </div>
              {shifted && <div className="pl-4.5 text-muted-brand">{shifted}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function RaceDetail() {
  const params = useParams();
  const n = parseInt(params.n ?? "1", 10);
  const { data: card, isLoading } = useQuery<CardWithRaces>({ queryKey: ["/api/cards/latest"] });
  const jarvis = useJarvis();

  if (isLoading || !card) {
    return <div className="p-6"><Skeleton className="h-96 w-full" /></div>;
  }

  const race = card.races.find((r) => r.raceNumber === n);
  if (!race) {
    return (
      <div className="p-6">
        <Link href="/" className="text-gold text-sm">← Back to card</Link>
        <div className="mt-4 text-silver">Race {n} not found.</div>
      </div>
    );
  }

  const cfg = tierOf(race.tier);
  const flags = parseFlags(race.flags);
  const bets = race.bets;
  const order = race.result ? (JSON.parse(race.result.finishOrder) as string[]) : null;
  const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gold hover:text-gold-light" data-testid="link-back"><ArrowLeft className="h-4 w-4" /> Back to card</Link>

      {/* Header */}
      <div className="mt-3 rounded-xl border border-gold/15 bg-navy-card p-5 relative overflow-hidden">
        <div className={`absolute left-0 inset-y-0 w-1.5 ${cfg.strip}`} />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between pl-2">
          <div className="flex items-center gap-4">
            <div className="font-display font-black text-3xl text-gold-light tabular-nums leading-none">R{race.raceNumber}</div>
            <div>
              <div className="flex items-center gap-2">
                <TierPill tier={race.tier} />
                <span className="text-xs text-muted-brand tabular-nums">{race.post}</span>
              </div>
              <div className="mt-1 text-sm font-display font-bold text-silver">{race.conditions}</div>
            </div>
          </div>
          <Button
            onClick={() => jarvis.briefViaPost(`/api/jarvis/brief-race/${race.id}`, `Race ${race.raceNumber} briefing`)}
            className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold self-start"
            data-testid="button-brief-this-race"
          >
            <Mic className="h-4 w-4 mr-1.5" /> BRIEF THIS RACE
          </Button>
        </div>
        {flags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 pl-2">
            {flags.map((f) => (
              <span key={f} className="inline-flex items-center gap-1 rounded border border-loss/30 bg-loss/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-loss">
                <Flag className="h-3 w-3" /> {f}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 3-column layout */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr_320px]">
        {/* Left: pace diagram */}
        <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Pace Shape</div>
          <PaceDiagram race={race} />
        </div>

        {/* Center: picks + editors */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">Top 4 Picks</div>
          <PickEditor race={race} locked={card.status === "completed"} />
          <RetierHistory race={race} />
        </div>

        {/* Right: reconciliation + wagers + grading */}
        <div className="space-y-4">
          <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">Reconciliation</div>
            <p className="text-xs text-slate-brand leading-relaxed">{race.read}</p>
            <div className="mt-3 pt-3 border-t border-gold/10">
              <div className="text-[10px] uppercase tracking-wider text-gold-dark mb-1">Shape</div>
              <p className="text-xs text-slate-brand leading-relaxed">{race.shape}</p>
            </div>
          </div>

          <div className="rounded-lg border border-gold/15 bg-navy-section p-4">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2">
              Suggested Wagers
              {bets && !bets.pass && bets.raceAllocation > 0
                ? ` · ${money(bets.raceAllocation)}`
                : ""}
            </div>
            <div className="space-y-2">
              {!bets || bets.pass || bets.legs.length === 0 ? (
                <div className="text-xs text-silver" data-testid="wager-pass">PASS — no playable edge.</div>
              ) : (
                bets.legs.map((leg, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs" data-testid={`wager-${i}`}>
                    <span className="shrink-0 rounded bg-gold/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold font-display font-bold">{leg.type}</span>
                    <span className="text-silver tabular-nums flex-1">{leg.structure}</span>
                    <span className="text-silver tabular-nums shrink-0">{money(leg.cost)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {race.result && order && (
            <div className="rounded-lg border border-gold/15 bg-navy-card p-4" data-testid="detail-grading">
              <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-2 flex items-center gap-2">
                <ScopeLogo size={16} /> Result · {order.join("-")}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  ["WIN", race.result.winHit], ["PLACE", race.result.placeHit],
                  ["SHOW", race.result.showHit], ["4TH", race.result.fourthHit],
                  ["EXACTA", race.result.exactaHit], ["TRIFECTA", race.result.trifectaHit],
                ].map(([k, hit]) => (
                  <div key={k as string} className={`flex items-center justify-between rounded px-2 py-1 ${hit ? "bg-win/10 text-win" : "bg-loss/10 text-loss"}`}>
                    <span className="uppercase tracking-wide">{k as string}</span>
                    {hit ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
