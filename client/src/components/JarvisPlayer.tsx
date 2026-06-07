import { useJarvis } from "@/lib/jarvis";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { X, Play, Pause, SkipBack, SkipForward, Loader2, Volume2 } from "lucide-react";

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function Waveform({ playing }: { playing: boolean }) {
  const bars = Array.from({ length: 14 });
  return (
    <div className="flex items-end justify-center gap-[3px] h-8" aria-hidden="true">
      {bars.map((_, i) => (
        <div
          key={i}
          className={`wave-bar w-[3px] rounded-full bg-gold ${playing ? "playing" : ""}`}
          style={{
            height: "100%",
            animationDelay: `${(i % 7) * 0.11}s`,
            opacity: playing ? 1 : 0.35,
            transform: playing ? undefined : "scaleY(0.3)",
          }}
        />
      ))}
    </div>
  );
}

export function JarvisPlayer() {
  const j = useJarvis();
  if (!j.open) return null;

  const progress = j.duration > 0 ? (j.currentTime / j.duration) * 100 : 0;

  return (
    <div
      data-testid="jarvis-player"
      className="fixed bottom-4 right-4 z-50 w-[20rem] max-w-[calc(100vw-2rem)] rounded-lg border border-gold/30 bg-navy-raised shadow-2xl backdrop-blur"
      style={{ boxShadow: "0 0 0 1px hsl(44 70% 47% / 0.12), 0 24px 48px -10px hsl(214 78% 1% / 0.8)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-gold/10">
        <ScopeLogo size={30} className={j.isPlaying ? "scope-pulse text-gold-light" : "text-gold"} />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-gold-dark font-display font-bold">
            JARVIS · NOW SPEAKING
          </div>
          <div className="text-xs text-silver truncate" data-testid="text-jarvis-label">
            {j.isLoading ? "Generating briefing…" : j.label || "Standby"}
          </div>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-brand hover:text-silver"
          onClick={j.close}
          data-testid="button-jarvis-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Waveform / progress */}
      <div className="px-4 py-3">
        {j.isLoading ? (
          <div className="flex items-center justify-center h-8 text-gold">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <Waveform playing={j.isPlaying} />
        )}
        <div className="mt-2 h-1 w-full rounded-full bg-navy-section overflow-hidden">
          <div
            className="h-full bg-gold transition-all"
            style={{ width: `${progress}%` }}
            data-testid="jarvis-progress"
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-brand tabular-nums">
          <span>{formatTime(j.currentTime)}</span>
          <span>{formatTime(j.duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2 p-3 pt-0">
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 text-silver hover:text-gold"
          onClick={() => j.skip(-10)}
          disabled={j.isLoading}
          data-testid="button-jarvis-skipback"
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          className="h-11 w-11 rounded-full bg-gold hover:bg-gold-light text-navy-bg"
          onClick={j.togglePlay}
          disabled={j.isLoading}
          data-testid="button-jarvis-toggle"
        >
          {j.isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 text-silver hover:text-gold"
          onClick={() => j.skip(10)}
          disabled={j.isLoading}
          data-testid="button-jarvis-skipforward"
        >
          <SkipForward className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1.5 ml-1 w-24">
          <Volume2 className="h-3.5 w-3.5 text-muted-brand shrink-0" />
          <Slider
            value={[j.volume * 100]}
            max={100}
            step={1}
            onValueChange={(v) => j.setVolume(v[0] / 100)}
            data-testid="slider-jarvis-volume"
          />
        </div>
      </div>
    </div>
  );
}
