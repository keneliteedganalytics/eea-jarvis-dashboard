import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { Card, DeepPostmortem, DeepRacePostmortem } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { TierPill } from "@/components/brand/TierPill";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Loader2, FlaskConical } from "lucide-react";

// Deep post-mortem ("answer key"): for a graded card, what we knew pre-race vs.
// what actually happened, and the visible signals we underweighted.

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function roiStr(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}u`;
}

const OUTCOME_LABEL: Record<DeepRacePostmortem["outcome"], string> = {
  hit: "WIN",
  place: "PLACE",
  show: "SHOW",
  itm: "ITM",
  miss: "MISS",
};

function RaceBlock({ race }: { race: DeepRacePostmortem }) {
  const [open, setOpen] = useState(false);
  const h = race.hindsightAnalysis;
  const flipped = h.visibleSignals.some((s) => s.wouldHaveFlipped);
  return (
    <div
      className="rounded-md border border-gold/10 bg-navy-card"
      data-testid={`postmortem-race-${race.raceNumber}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        data-testid={`postmortem-race-toggle-${race.raceNumber}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-brand" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-brand" />
          )}
          <span className="font-display font-black tabular-nums text-gold-light">
            R{race.raceNumber}
          </span>
          <TierPill tier={race.ourTopPick.tier} />
          <span className="truncate text-sm text-silver">
            {race.ourTopPick.runner}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {flipped && (
            <span
              className="rounded border border-loss/40 bg-loss/10 px-1.5 py-0.5 text-[9px] font-display font-bold uppercase tracking-[0.12em] text-loss"
              data-testid={`postmortem-flippable-${race.raceNumber}`}
            >
              Flippable
            </span>
          )}
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-display font-bold uppercase tracking-[0.1em] ${
              race.outcome === "hit"
                ? "bg-win/15 text-win"
                : race.outcome === "miss"
                  ? "bg-loss/15 text-loss"
                  : "bg-gold/10 text-gold-light"
            }`}
          >
            {OUTCOME_LABEL[race.outcome]}
          </span>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-gold/10 px-4 py-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Our top pick</div>
              <div className="text-silver">
                {race.ourTopPick.runner}{" "}
                <span className="text-muted-brand">({race.ourTopPick.tier}, {race.ourTopPick.rating.toFixed(1)})</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Actual winner</div>
              <div className="text-silver">
                #{race.actualWinner.programNumber} {race.actualWinner.runner}
                {race.actualWinner.odds != null && (
                  <span className="text-muted-brand"> @ {race.actualWinner.odds}</span>
                )}
              </div>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-brand">
              Where the winner sat in our numbers
            </div>
            <div className="text-silver">
              {h.winnerWasInPool
                ? `In our pool — tier ${h.winnerTier ?? "?"}, rating ${h.winnerRating != null ? h.winnerRating.toFixed(1) : "?"}.`
                : "Not in our prediction pool at all."}
            </div>
          </div>

          {h.visibleSignals.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">
                Visible signals we underweighted
              </div>
              <ul className="mt-1 space-y-1">
                {h.visibleSignals.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span
                      className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${s.wouldHaveFlipped ? "bg-loss" : "bg-gold"}`}
                    />
                    <span className="text-silver">
                      <span className="font-medium text-gold-light">{s.signal}:</span> {s.detail}
                      {s.wouldHaveFlipped && (
                        <span className="text-loss"> (would have flipped the call)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {h.overweightedFactors.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">
                Factors we overweighted
              </div>
              <ul className="mt-1 list-inside list-disc text-silver">
                {h.overweightedFactors.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Pace shape</div>
              <div className="text-silver">{race.paceShape}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Bias</div>
              <div className="text-silver">{race.biasAlignment}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Weather</div>
              <div className="text-silver">{race.weatherAlignment}</div>
            </div>
          </div>

          {(race.scratches.preLocked.length > 0 ||
            race.scratches.postLocked.length > 0) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-brand">Scratches</div>
              <div className="text-silver">
                {race.scratches.preLocked.length > 0 && (
                  <span>Pre-lock: {race.scratches.preLocked.join(", ")}. </span>
                )}
                {race.scratches.postLocked.length > 0 && (
                  <span>Post-lock: {race.scratches.postLocked.join(", ")}. </span>
                )}
                {race.scratches.impactedTopPick && (
                  <span className="text-loss">Hit our top pick.</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Report({ report }: { report: DeepPostmortem }) {
  const s = report.summary;
  return (
    <div className="space-y-4" data-testid={`postmortem-report-${report.cardId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-black text-gold-light">
          {report.track} — {report.date}
        </h2>
        <span className="text-xs text-muted-brand">
          Generated {new Date(report.generatedAt).toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Graded" value={`${s.graded}/${s.raceCount}`} />
        <Stat label="Win rate" value={pct(s.winRate)} />
        <Stat label="ITM rate" value={pct(s.itmRate)} />
        <Stat label="ROI" value={roiStr(s.roi)} tone={s.roi > 0 ? "win" : s.roi < 0 ? "loss" : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-win/20 bg-win/5 p-3">
          <div className="text-[10px] uppercase tracking-wide text-win">Best call</div>
          <div className="text-sm text-silver">
            R{s.bestCall.raceNumber} {s.bestCall.runner} ({s.bestCall.tier}) — {s.bestCall.reason}
          </div>
        </div>
        <div className="rounded-md border border-loss/20 bg-loss/5 p-3">
          <div className="text-[10px] uppercase tracking-wide text-loss">Worst miss</div>
          <div className="text-sm text-silver">
            R{s.worstMiss.raceNumber}: we had {s.worstMiss.ourPick}, winner was{" "}
            {s.worstMiss.actualWinner}. {s.worstMiss.visibleSignal}
          </div>
        </div>
      </div>

      {report.lessons.length > 0 && (
        <div className="rounded-md border border-gold/15 bg-navy-section p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-brand">Lessons</div>
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-silver">
            {report.lessons.map((l, i) => (
              <li key={i} data-testid={`postmortem-lesson-${i}`}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {report.systemicFlags.length > 0 && (
        <div className="rounded-md border border-loss/25 bg-loss/5 p-3">
          <div className="text-[10px] uppercase tracking-wide text-loss">Systemic flags</div>
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-silver">
            {report.systemicFlags.map((f, i) => (
              <li key={i} data-testid={`postmortem-flag-${i}`}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        {report.races.map((r) => (
          <RaceBlock key={r.raceNumber} race={r} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" }) {
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

export default function Postmortem() {
  const { toast } = useToast();
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);

  const { data: cards } = useQuery<Card[]>({ queryKey: ["/api/cards"] });

  const { data: report, isLoading } = useQuery<DeepPostmortem>({
    queryKey: [`/api/cards/${selectedCardId}/deep-postmortem`],
    enabled: selectedCardId != null,
    retry: false,
  });

  const runCard = useMutation({
    mutationFn: async (cardId: number) => {
      const res = await apiRequest("POST", `/api/cards/${cardId}/deep-postmortem`, {});
      return (await res.json()) as DeepPostmortem;
    },
    onSuccess: (data) => {
      queryClient.setQueryData([`/api/cards/${data.cardId}/deep-postmortem`], data);
      setSelectedCardId(data.cardId);
      toast({ title: "Deep post-mortem ready", description: `${data.track} ${data.date}` });
    },
    onError: (e) =>
      toast({ title: "Run failed", description: (e as Error).message, variant: "destructive" }),
  });

  const runToday = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/postmortem/today", {});
      return (await res.json()) as DeepPostmortem[];
    },
    onSuccess: (reports) => {
      for (const r of reports) {
        queryClient.setQueryData([`/api/cards/${r.cardId}/deep-postmortem`], r);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      if (reports.length) setSelectedCardId(reports[0].cardId);
      toast({
        title: reports.length ? "Today's post-mortem ready" : "Nothing to grade",
        description: reports.length
          ? `${reports.length} card(s) analyzed`
          : "No graded cards from today.",
      });
    },
    onError: (e) =>
      toast({ title: "Run failed", description: (e as Error).message, variant: "destructive" }),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6" data-testid="page-postmortem">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-black text-gold-light">Deep Post-Mortem</h1>
          <p className="text-sm text-muted-brand">
            The answer key — what we knew pre-race vs. what actually happened.
          </p>
        </div>
        <Button
          onClick={() => runToday.mutate()}
          disabled={runToday.isPending}
          data-testid="button-run-today"
        >
          {runToday.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FlaskConical className="mr-2 h-4 w-4" />
          )}
          Run Today's Postmortem
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedCardId ?? ""}
          onChange={(e) => setSelectedCardId(e.target.value ? Number(e.target.value) : null)}
          className="rounded border border-gold/20 bg-navy-section px-2 py-1.5 text-sm text-silver"
          data-testid="select-card"
        >
          <option value="">Select a card…</option>
          {(cards ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.track} — {c.date}
            </option>
          ))}
        </select>
        {selectedCardId != null && (
          <Button
            variant="secondary"
            onClick={() => runCard.mutate(selectedCardId)}
            disabled={runCard.isPending}
            data-testid="button-run-card"
          >
            {runCard.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Run Deep Postmortem
          </Button>
        )}
      </div>

      {selectedCardId == null && (
        <p className="text-sm text-muted-brand" data-testid="postmortem-empty">
          Pick a graded card and run the deep post-mortem, or run today's whole slate.
        </p>
      )}
      {selectedCardId != null && isLoading && (
        <div className="flex items-center gap-2 text-muted-brand">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {selectedCardId != null && !isLoading && !report && (
        <p className="text-sm text-muted-brand" data-testid="postmortem-not-run">
          No deep post-mortem for this card yet. Hit "Run Deep Postmortem" above.
        </p>
      )}
      {report && <Report report={report} />}
    </div>
  );
}
