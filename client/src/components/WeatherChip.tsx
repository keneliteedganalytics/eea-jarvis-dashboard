import type { RaceWeather, SurfaceImpact } from "@shared/schema";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Cloud, CloudRain, CloudSnow, Sun, Zap, CloudFog, Navigation } from "lucide-react";

// Surface label + color per impact tier. Matches the dashboard's dark/navy
// theme (gold accents, win/loss tokens) — no new palette.
const SURFACE: Record<SurfaceImpact, { label: string; cls: string }> = {
  dry: { label: "DRY", cls: "text-silver bg-white/[0.06] border-slate-brand/30" },
  damp: { label: "DAMP", cls: "text-gold bg-gold/10 border-gold/30" },
  wet: { label: "WET", cls: "text-gold-light bg-gold/15 border-gold/40" },
  sloppy: { label: "SLOPPY", cls: "text-loss bg-loss/10 border-loss/30" },
  muddy: { label: "MUDDY", cls: "text-loss bg-loss/15 border-loss/40" },
  unknown: { label: "—", cls: "text-muted-brand bg-white/[0.04] border-slate-brand/20" },
};

function conditionIcon(conditions: string | null) {
  const c = (conditions || "").toLowerCase();
  const cls = "h-3 w-3";
  if (c.includes("thunder") || c.includes("storm")) return <Zap className={cls} />;
  if (c.includes("snow")) return <CloudSnow className={cls} />;
  if (c.includes("rain") || c.includes("drizzle")) return <CloudRain className={cls} />;
  if (c.includes("fog") || c.includes("mist") || c.includes("haze")) return <CloudFog className={cls} />;
  if (c.includes("cloud")) return <Cloud className={cls} />;
  return <Sun className={cls} />;
}

export function WeatherChip({ weather }: { weather?: RaceWeather | null }) {
  const surface: SurfaceImpact = weather?.surfaceImpact ?? "unknown";
  const cfg = SURFACE[surface];
  const isUnknown = surface === "unknown";

  const chip = (
    <span
      data-testid={`weather-chip-${surface}`}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-display font-bold tabular-nums",
        cfg.cls,
        isUnknown && "opacity-60",
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {!isUnknown && conditionIcon(weather?.conditions ?? null)}
      {!isUnknown && weather?.tempF != null && <span>{Math.round(weather.tempF)}°</span>}
      <span>{cfg.label}</span>
    </span>
  );

  if (isUnknown) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="text-[11px]">
        <div className="space-y-0.5">
          <div className="font-bold">{weather?.conditions ?? "—"}</div>
          {weather?.feelsLikeF != null && <div>Feels like {Math.round(weather.feelsLikeF)}°F</div>}
          {weather?.windMph != null && (
            <div className="flex items-center gap-1">
              Wind {Math.round(weather.windMph)} mph
              {weather.windDirDeg != null && (
                <Navigation
                  className="h-2.5 w-2.5"
                  style={{ transform: `rotate(${weather.windDirDeg}deg)` }}
                />
              )}
            </div>
          )}
          {weather?.humidityPct != null && <div>Humidity {Math.round(weather.humidityPct)}%</div>}
          {weather?.precipMm != null && <div>Precip {weather.precipMm} mm/h</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
