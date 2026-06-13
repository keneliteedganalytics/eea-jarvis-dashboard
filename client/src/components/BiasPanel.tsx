import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

// Same dev/prod base-URL shim the query client + SSE hook use.
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// v3.2 card-scoped track-bias state, as returned by GET /api/cards/:id/bias-state
// (the raw BiasState from server/services/track_bias_detector.ts, plus cardId).
export interface BiasState {
  cardId?: number;
  active: boolean;
  nGraded: number;
  hotPps: string[];
  deadPps: string[];
  ppWinRates: Record<string, number>;
  styleBias: "FRONT" | "STALKER" | "CLOSER" | null;
  styleDistribution: Record<string, number>;
  confidence: number;
  thresholds: {
    hotPpThreshold: number;
    minRacesForSignal: number;
    minRacesForDeadPp: number;
    styleBiasThreshold: number;
  };
}

export function biasStateKey(cardId: number) {
  return ["/api/cards", String(cardId), "bias-state"] as const;
}

// Map the detector's running-style to the brief's UI vocabulary + color.
function styleChip(style: BiasState["styleBias"]): {
  label: string;
  className: string;
} {
  if (style === "FRONT")
    return {
      label: "Early Speed",
      className: "border-transparent bg-orange-500/15 text-orange-400",
    };
  if (style === "CLOSER")
    return {
      label: "Closer",
      className: "border-transparent bg-sky-500/15 text-sky-400",
    };
  // STALKER or null both read as "neutral" in the brief.
  return {
    label: "Neutral",
    className: "border-transparent bg-muted text-muted-brand",
  };
}

const MIN_FOR_SIGNAL = 3;

export function BiasPanel({ cardId }: { cardId: number }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<BiasState>({
    queryKey: biasStateKey(cardId),
    // Live cards grade over the day; keep this fresh and poll as an SSE fallback.
    refetchInterval: 30_000,
    staleTime: 0,
  });

  // Reuse the existing SSE stream (/api/events). Events arrive as `message`
  // events whose JSON payload carries a `type`; refetch on `bias_updated` for
  // this card. This supplements the 30s poll above so the panel updates the
  // instant a race is graded.
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API_BASE}/api/events`);
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        if (
          (event.type === "bias_updated" || event.type === "race-graded") &&
          (event.cardId == null || Number(event.cardId) === cardId)
        ) {
          queryClient.invalidateQueries({ queryKey: biasStateKey(cardId) });
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    es.addEventListener("message", onMessage);
    return () => {
      es?.removeEventListener("message", onMessage);
      es?.close();
    };
  }, [cardId, queryClient]);

  if (isLoading || !data) return null;

  const graded = data.nGraded ?? 0;

  // Empty / pre-signal state: fewer than 3 graded, or no signal yet.
  if (!data.active) {
    return (
      <Card className="border-gold/15 bg-navy-card" data-testid="bias-panel">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold">
            v3.2 Track Bias
          </div>
          <div className="text-[11px] text-muted-brand tabular-nums">
            Awaiting Signal ({Math.min(graded, MIN_FOR_SIGNAL)}/{MIN_FOR_SIGNAL} graded)
          </div>
        </CardContent>
      </Card>
    );
  }

  const chip = styleChip(data.styleBias);
  const confidencePct = Math.round(Math.min(0.85, data.confidence) * 100);

  return (
    <Card className="border-gold/20 bg-navy-card" data-testid="bias-panel">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold">
            v3.2 Track Bias
          </div>
          <div className="text-[10px] text-muted-brand tabular-nums">
            {graded} graded
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Hot PPs */}
          {data.hotPps.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-brand">
                Hot PP
              </span>
              {data.hotPps.map((pp) => (
                <Badge
                  key={`hot-${pp}`}
                  className="border-transparent bg-win/15 text-win tabular-nums"
                  data-testid={`bias-hot-pp-${pp}`}
                >
                  #{pp}
                </Badge>
              ))}
            </div>
          )}

          {/* Dead PPs */}
          {data.deadPps.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-brand">
                Dead PP
              </span>
              {data.deadPps.map((pp) => (
                <Badge
                  key={`dead-${pp}`}
                  variant="secondary"
                  className="tabular-nums text-muted-brand"
                  data-testid={`bias-dead-pp-${pp}`}
                >
                  #{pp}
                </Badge>
              ))}
            </div>
          )}

          {/* Style bias chip */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-brand">
              Style
            </span>
            <Badge className={chip.className} data-testid="bias-style-chip">
              {chip.label}
            </Badge>
          </div>
        </div>

        {/* Confidence bar (0–85%) */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.14em] text-muted-brand">
              Confidence
            </span>
            <span className="text-[11px] text-gold-light tabular-nums font-display font-bold">
              {confidencePct}%
            </span>
          </div>
          {/* The detector caps confidence at 0.85; scale the bar to that ceiling
              so a maxed-out signal fills the track. */}
          <Progress
            value={(confidencePct / 85) * 100}
            data-testid="bias-confidence-bar"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Build the hover/title text describing the adjustments a bias signal applies to
// an ungraded race's contenders. Used by the race-card "v3.2 bias applied" pill.
export function biasAdjustmentSummary(state: BiasState): string {
  const parts: string[] = [];
  if (state.hotPps.length)
    parts.push(`Hot PP ${state.hotPps.map((p) => `#${p}`).join(", ")} +1.5`);
  if (state.deadPps.length)
    parts.push(`Dead PP ${state.deadPps.map((p) => `#${p}`).join(", ")} −0.5`);
  if (state.styleBias === "FRONT") parts.push("Early-speed style ±1.0");
  else if (state.styleBias === "CLOSER") parts.push("Closer style ±1.0");
  parts.push(`confidence ${Math.round(Math.min(0.85, state.confidence) * 100)}%`);
  return `v3.2 bias applied — ${parts.join("; ")}`;
}
