import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Lock, Eye, FileText } from "lucide-react";

// Draft = an active, unlocked card awaiting review. The /api/cards/drafts
// endpoint returns lightweight summaries (track, date, counts) so this section
// never pulls full race rows for cards the user hasn't opened yet.
interface DraftSummary {
  id: number;
  track: string;
  date: string;
  raceCount: number;
  cardConviction: string | null;
  sniper: number;
  edge: number;
  createdAt: string;
}

export function DraftCardsSection() {
  const { toast } = useToast();
  const { data: drafts = [] } = useQuery<DraftSummary[]>({ queryKey: ["/api/cards/drafts"] });

  const lockMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/cards/${id}/publish`, {});
    },
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/drafts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      toast({ title: `Card #${id} locked`, description: "It's live for grading and the poller." });
    },
    onError: (e) => {
      toast({ title: "Lock failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  if (!drafts.length) return null;

  return (
    <div className="mt-4">
      <div className="rounded-lg border border-gold/15 bg-navy-section p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4 text-gold-dark" />
          <span className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold">
            Drafts — awaiting review
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {drafts.map((d) => (
            <div
              key={d.id}
              className="rounded-md border border-gold/10 bg-navy-card p-3"
              data-testid={`draft-card-${d.id}`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-display font-bold text-silver">{d.track}</span>
                <span className="text-[11px] tabular-nums text-muted-brand">{d.date}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-brand tabular-nums">
                <span>{d.raceCount} races</span>
                <span className="text-gold">{d.cardConviction ?? "—"}</span>
                <span className="text-gold-light">{d.sniper} SNIPER</span>
                <span>{d.edge} EDGE</span>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(`#/review/${d.id}`, "_self")}
                  className="border-gold/30 text-gold hover:bg-gold/10 flex-1"
                  data-testid={`draft-review-${d.id}`}
                >
                  <Eye className="h-3.5 w-3.5 mr-1 shrink-0" /> Review
                </Button>
                <Button
                  size="sm"
                  onClick={() => lockMutation.mutate(d.id)}
                  disabled={lockMutation.isPending}
                  className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold flex-1"
                  data-testid={`draft-lock-${d.id}`}
                >
                  <Lock className="h-3.5 w-3.5 mr-1 shrink-0" /> Lock
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
