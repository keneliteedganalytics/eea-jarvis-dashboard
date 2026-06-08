import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CardWithRaces, ShowManifest } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Loader2, Play, RotateCcw, Download, Film } from "lucide-react";

interface ShowResponse {
  status: "ready" | "building" | "error" | "missing";
  manifest?: ShowManifest;
  error?: string;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

export default function DailyShow() {
  // The show is built per card; default to the latest (active) card.
  const { data: card } = useQuery<CardWithRaces>({ queryKey: ["/api/cards/latest"] });
  const cardId = card?.id;

  const { data: show, isLoading } = useQuery<ShowResponse>({
    queryKey: ["/api/show", cardId],
    enabled: cardId != null,
    // Poll every 5s until the show is ready (or hard-errored).
    refetchInterval: (q) => {
      const s = (q.state.data as ShowResponse | undefined)?.status;
      return s === "ready" || s === "error" ? false : 5000;
    },
    // 404 (missing) should resolve to a status, not throw — fetch manually.
    queryFn: async () => {
      const res = await fetch(`/api/show/${cardId}`);
      if (res.status === 404) return { status: "missing" } as ShowResponse;
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as ShowResponse;
    },
  });

  const segments = show?.manifest?.segments ?? [];
  const [activeIdx, setActiveIdx] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const activeSegment = segments[activeIdx];
  const videoSrc = useMemo(
    () => (cardId != null && activeSegment ? `/show/${cardId}/${activeSegment.filename}` : ""),
    [cardId, activeSegment],
  );

  // When the source changes, load + play.
  useEffect(() => {
    if (videoRef.current && videoSrc) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [videoSrc]);

  // Auto-advance to the next segment when one ends.
  function handleEnded() {
    setActiveIdx((i) => (i + 1 < segments.length ? i + 1 : i));
  }

  if (isLoading || !card) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  const building = show?.status === "building" || show?.status === "missing";
  const errored = show?.status === "error";

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <Film className="h-5 w-5 text-gold" />
        <div>
          <h1 className="text-lg font-display font-black text-gold-light">Daily Show</h1>
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-brand">
            {card.track} · {card.date}
          </div>
        </div>
      </div>

      {building && (
        <div
          className="rounded-lg border border-gold/15 bg-navy-card p-12 flex flex-col items-center justify-center gap-4 text-center"
          data-testid="show-building"
        >
          <Loader2 className="h-8 w-8 text-gold animate-spin" />
          <div className="text-silver font-display font-bold">Building today's show…</div>
          <div className="text-[12px] text-muted-brand max-w-md">
            Jarvis and Scarlett are heading trackside. Veo is rendering the segments — this can take
            several minutes. The page will load it automatically when ready.
          </div>
        </div>
      )}

      {errored && (
        <div
          className="rounded-lg border border-red-500/30 bg-navy-card p-8 text-center"
          data-testid="show-error"
        >
          <div className="text-red-400 font-display font-bold mb-2">Show build failed</div>
          <div className="text-[12px] text-muted-brand">{show?.error || "Unknown error."}</div>
        </div>
      )}

      {show?.status === "ready" && segments.length > 0 && (
        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          {/* Player */}
          <div className="space-y-3">
            <div className="rounded-lg overflow-hidden border border-gold/15 bg-black aspect-video">
              <video
                ref={videoRef}
                className="w-full h-full"
                controls
                playsInline
                onEnded={handleEnded}
                data-testid="video-player"
                src={videoSrc}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm text-silver font-display font-bold mr-auto">
                {activeSegment?.label}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-gold/25 text-gold-light"
                data-testid="button-replay"
                onClick={() => {
                  setActiveIdx(0);
                  if (videoRef.current) {
                    videoRef.current.currentTime = 0;
                    videoRef.current.play().catch(() => {});
                  }
                }}
              >
                <RotateCcw className="h-4 w-4 mr-1" /> Replay show
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-gold/25 text-gold-light"
                data-testid="button-jump-overview"
                onClick={() => setActiveIdx(0)}
              >
                <Play className="h-4 w-4 mr-1" /> Jump to overview
              </Button>
              {videoSrc && (
                <a href={videoSrc} download data-testid="button-download">
                  <Button size="sm" variant="outline" className="border-gold/25 text-gold-light">
                    <Download className="h-4 w-4 mr-1" /> Download MP4
                  </Button>
                </a>
              )}
            </div>
          </div>

          {/* Playlist sidebar */}
          <div className="rounded-lg border border-gold/10 bg-navy-card p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3 px-1">
              Playlist
            </div>
            <div className="flex flex-col gap-1">
              {segments.map((seg, i) => {
                const active = i === activeIdx;
                return (
                  <button
                    key={seg.id}
                    onClick={() => setActiveIdx(i)}
                    data-testid={`button-playlist-segment-${seg.id}`}
                    className={
                      "flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors " +
                      (active
                        ? "bg-gold/12 border border-gold/25"
                        : "border border-transparent hover:bg-white/[0.03]")
                    }
                  >
                    <div className="relative w-20 shrink-0 aspect-video rounded overflow-hidden border border-gold/10 bg-black/60">
                      <img
                        src={cardId != null ? `/show/${cardId}/${seg.filename}` : ""}
                        alt=""
                        className="w-full h-full object-cover opacity-80"
                        // Poster frame: the video's first frame; fall back silently.
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.visibility = "hidden";
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div
                        className={
                          "text-[13px] font-medium truncate " +
                          (active ? "text-gold-light" : "text-silver")
                        }
                      >
                        {seg.label}
                      </div>
                      <div className="text-[10px] text-muted-brand tabular-nums">
                        {fmtDuration(seg.durationSec)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
