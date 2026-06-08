import { useMutation } from "@tanstack/react-query";
import type { FusionReplay, FusionRaceDiff } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { TierPill } from "@/components/brand/TierPill";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Repeat, Check, X, ArrowRight } from "lucide-react";

// Fusion Replay panel (PR #28): re-runs the card through the latest tier-tuning
// v2 rules against the preserved snapshot (no re-ingest) and shows, race by race,
// original tier → new tier, which rules fired, and whether the new logic would
// have caught the actual winner. Attaches below the deep post-mortem.

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "win" | "loss";
}) {
  return (
    <div className="rounded-md border border-gold/10 bg-navy-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-brand">{label}</div>
      <div
        className={`font-display text-lg font-black tabular-nums ${
          tone === "win" ? "text-win" : tone === "loss" ? "text-loss" : "text-gold-light"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function DiffRow({ diff }: { diff: FusionRaceDiff }) {
  return (
    <div
      className="rounded-md border border-gold/10 bg-navy-card px-4 py-3"
      data-testid={`replay-race-${diff.raceNumber}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-display font-black tabular-nums text-gold-light">
            R{diff.raceNumber}
          </span>
          <TierPill tier={diff.original.tier} size="sm" />
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-brand" />
          <TierPill tier={diff.replayed.tier} size="sm" />
          {diff.changed && (
            <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[9px] font-display font-bold uppercase tracking-[0.12em] text-gold-light">
              Changed
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {diff.wouldHaveCaught && (
            <span
              className="flex items-center gap-1 rounded border border-win/40 bg-win/10 px-1.5 py-0.5 text-[10px] font-display font-bold uppercase tracking-[0.1em] text-win"
              data-testid={`replay-caught-${diff.raceNumber}`}
            >
              <Check className="h-3 w-3" /> Caught
            </span>
          )}
          {diff.wouldHaveLost && (
            <span
              className="flex items-center gap-1 rounded border border-loss/40 bg-loss/10 px-1.5 py-0.5 text-[10px] font-display font-bold uppercase tracking-[0.1em] text-loss"
              data-testid={`replay-lost-${diff.raceNumber}`}
            >
              <X className="h-3 w-3" /> Lost
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-brand">Original top</div>
          <div className="text-silver">
            {diff.original.topPick}{" "}
            <span className="text-muted-brand tabular-nums">({diff.original.rating.toFixed(1)})</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-brand">Replayed top</div>
          <div className="text-silver">
            {diff.replayed.topPick}{" "}
            <span className="text-muted-brand tabular-nums">({diff.replayed.rating.toFixed(1)})</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-brand">Actual winner</div>
          <div className="text-silver">
            {diff.actualWinner.program
              ? `#${diff.actualWinner.program} ${diff.actualWinner.horse}`
              : "— (ungraded)"}
          </div>
        </div>
      </div>

      {diff.rulesFired.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`replay-rules-${diff.raceNumber}`}>
          {diff.rulesFired.map((rule) => (
            <span
              key={rule}
              className="rounded border border-gold/20 bg-navy-section px-1.5 py-0.5 text-[9px] font-display font-bold uppercase tracking-[0.1em] text-gold-light"
            >
              {rule.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FusionReplayPanel({ cardId }: { cardId: number }) {
  const { toast } = useToast();

  const replay = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/cards/${cardId}/fusion-replay`, {});
      return (await res.json()) as FusionReplay;
    },
    onError: (e) =>
      toast({ title: "Replay failed", description: (e as Error).message, variant: "destructive" }),
  });

  const data = replay.data;
  const s = data?.summary;

  return (
    <div
      className="space-y-4 rounded-md border border-gold/15 bg-navy-section p-4"
      data-testid={`fusion-replay-panel-${cardId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-black text-gold-light">Fusion Replay</h3>
          <p className="text-sm text-muted-brand">
            Re-run this card through the latest tier-tuning rules — no re-ingest. See which misses
            the new logic would have caught.
          </p>
        </div>
        <Button
          onClick={() => replay.mutate()}
          disabled={replay.isPending}
          data-testid="button-run-replay"
        >
          {replay.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Repeat className="mr-2 h-4 w-4" />
          )}
          Run Replay
        </Button>
      </div>

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Tier changes" value={`${s.tierChanges}`} />
            <Stat
              label="Misses caught"
              value={`${s.missesCaught}`}
              tone={s.missesCaught > 0 ? "win" : undefined}
            />
            <Stat
              label="Misses introduced"
              value={`${s.missesIntroduced}`}
              tone={s.missesIntroduced > 0 ? "loss" : undefined}
            />
            <Stat
              label="Net improvement"
              value={`${s.netImprovement >= 0 ? "+" : ""}${s.netImprovement}`}
              tone={s.netImprovement > 0 ? "win" : s.netImprovement < 0 ? "loss" : undefined}
            />
          </div>

          <div className="space-y-2" data-testid="replay-diffs">
            {data!.diffs.map((d) => (
              <DiffRow key={d.raceNumber} diff={d} />
            ))}
          </div>
        </>
      )}

      {!s && !replay.isPending && (
        <p className="text-sm text-muted-brand" data-testid="replay-empty">
          Hit "Run Replay" to validate the latest fusion rules against this card's locked numbers.
        </p>
      )}
    </div>
  );
}
