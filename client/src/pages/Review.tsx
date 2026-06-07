import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import type { Card, RaceWithResult, Prediction } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { TierPill } from "@/components/brand/TierPill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type RaceWithPredictions = RaceWithResult & { predictions: Prediction[] };
type ReviewCard = Card & { races: RaceWithPredictions[] };

const TIERS = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;

function num(x: number | null): string {
  return x == null ? "—" : x.toFixed(1);
}

function PredictionRow({ p }: { p: Prediction }) {
  const { toast } = useToast();
  const reasoning = (() => {
    if (!p.llmReasoning) return null;
    try {
      return JSON.parse(p.llmReasoning) as { why?: string[]; paceMatchup?: string };
    } catch {
      return null;
    }
  })();

  const setTier = useMutation({
    mutationFn: async (tier: string) => {
      await apiRequest("PATCH", `/api/predictions/${p.id}`, { tierAssigned: tier });
    },
    onSuccess: () => {
      toast({ title: "Tier updated", description: `${p.horseName} → reload reflects change.` });
    },
    onError: (e) => toast({ title: "Update failed", description: (e as Error).message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-gold/10 bg-navy-card p-3" data-testid={`prediction-${p.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display font-black text-gold-light tabular-nums">{p.horsePgm}</span>
          <span className="text-sm text-silver truncate">{p.horseName}</span>
          {p.rank != null && (
            <span className="text-[10px] text-muted-brand">#{p.rank}</span>
          )}
        </div>
        <select
          defaultValue={p.tierAssigned ?? "PASS"}
          onChange={(e) => setTier.mutate(e.target.value)}
          className="rounded border border-gold/20 bg-navy-section px-1.5 py-1 text-[10px] text-silver"
          data-testid={`select-tier-${p.id}`}
        >
          {TIERS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-3 text-[10px] text-muted-brand tabular-nums">
        <span>EEAS {num(p.eeas)}</span>
        <span>EEAP {num(p.eeap)}</span>
        <span>EEAC {num(p.eeac)}</span>
        <span className="text-gold-dark">RATING {num(p.eeaRating)}</span>
      </div>
      {reasoning?.why?.length ? (
        <ul className="mt-1 list-disc pl-4 text-[11px] text-slate-brand space-y-0.5">
          {reasoning.why.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      {reasoning?.paceMatchup ? (
        <div className="text-[10px] text-muted-brand italic">{reasoning.paceMatchup}</div>
      ) : null}
    </div>
  );
}

function RaceBlock({ race }: { race: RaceWithPredictions }) {
  const ranked = [...race.predictions].sort((a, b) => {
    const ra = a.rank ?? 99;
    const rb = b.rank ?? 99;
    if (ra !== rb) return ra - rb;
    return (b.eeaRating ?? 0) - (a.eeaRating ?? 0);
  });
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-section p-4" data-testid={`review-race-${race.raceNumber}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-display font-black text-xl text-gold-light">R{race.raceNumber}</span>
        <TierPill tier={race.tier} size="sm" />
        <span className="text-xs text-silver truncate">{race.conditions}</span>
      </div>
      {race.whyText && (
        <div className="mb-2 text-[11px] text-slate-brand">{race.whyText}</div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {ranked.map((p) => (
          <PredictionRow key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}

export default function Review() {
  const params = useParams();
  const id = params.id;
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: card, isLoading } = useQuery<ReviewCard>({
    queryKey: [`/api/cards/${id}/review`],
    enabled: !!id,
  });

  const publish = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/cards/${id}/publish`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      toast({ title: "Card published", description: "It's live on the dashboard now." });
      navigate("/");
    },
    onError: (e) => toast({ title: "Publish failed", description: (e as Error).message, variant: "destructive" }),
  });

  const discard = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/cards/${id}/discard`, {});
    },
    onSuccess: () => {
      toast({ title: "Draft discarded" });
      navigate("/");
    },
    onError: (e) => toast({ title: "Discard failed", description: (e as Error).message, variant: "destructive" }),
  });

  if (isLoading || !card) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-16 w-full" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto pb-28">
      <div className="rounded-xl border border-gold/15 bg-navy-card p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-brand">Review &amp; Confirm</div>
          <div className="font-display font-black text-xl text-gold-light">
            {card.track} · {card.date}
          </div>
          <div className="text-[11px] text-muted-brand">
            {card.races.length} races · edit tiers, then publish to go live
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => discard.mutate()}
            disabled={discard.isPending}
            className="border-loss/40 text-loss hover:bg-loss/10"
            data-testid="button-discard"
          >
            <Trash2 className="h-4 w-4 mr-1.5" /> Discard
          </Button>
          <Button
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
            className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
            data-testid="button-publish"
          >
            {publish.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />}
            Publish Card
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {[...card.races]
          .sort((a, b) => a.raceNumber - b.raceNumber)
          .map((race) => (
            <RaceBlock key={race.id} race={race} />
          ))}
      </div>
    </div>
  );
}
