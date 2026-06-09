import { useEffect } from "react";
import { useJarvis } from "@/lib/jarvis";
import { queryClient } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Connects to the server's SSE stream. When the auto-fetcher lands a result,
// the server broadcasts a "race_result" event; we fire the Jarvis recap and
// refresh the data.
export function useLiveEvents() {
  const jarvis = useJarvis();
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API_BASE}/api/events`);
    } catch {
      return;
    }
    es.addEventListener("message", async (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === "race_result") {
          queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
          queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
          if (event.autoRecap) {
            jarvis.briefViaPost(
              `/api/jarvis/recap-race/${event.raceId}`,
              `Race ${event.raceNumber ?? event.raceId} recap`,
            );
          }
        } else if (event.type === "race-graded") {
          // PR #44: OTB auto-grader landed a result. Refresh the card + bankroll
          // and toast the winner + net.
          queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
          queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
          if (event.cardId != null) {
            queryClient.invalidateQueries({ queryKey: ["/api/cards", String(event.cardId), "bankroll"] });
          }
          const winner = event.winnerName
            ? `#${event.winnerPgm} ${event.winnerName}`
            : `#${event.winnerPgm}`;
          const bal = typeof event.balance === "number" ? ` — bankroll $${event.balance.toFixed(2)}` : "";
          toast({
            title: `R${event.raceNumber ?? ""} graded`,
            description: `Winner ${winner}${bal}`,
          });
        } else if (event.type === "tuning_proposals") {
          queryClient.invalidateQueries({ queryKey: ["/api/tuning-proposals"] });
        } else if (event.type === "card_updated") {
          // Silent in-place recompute after a voice tier change / undo.
          queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"] });
          queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
        } else if (event.type === "on-demand-ingest:completed") {
          // A draft (or partial) card just landed — refresh the Drafts section.
          queryClient.invalidateQueries({ queryKey: ["/api/cards/drafts"] });
          queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
        }
      } catch {
        /* ignore malformed */
      }
    });
    return () => {
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
