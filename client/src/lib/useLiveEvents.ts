import { useEffect } from "react";
import { useJarvis } from "@/lib/jarvis";
import { queryClient } from "@/lib/queryClient";

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
