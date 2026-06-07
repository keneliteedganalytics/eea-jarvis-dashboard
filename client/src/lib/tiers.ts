export type Tier = "SNIPER" | "EDGE" | "DUAL" | "RECON" | "PASS";

export interface TierConfig {
  label: string;
  // tailwind classes
  text: string;
  bg: string;
  border: string;
  strip: string; // solid color strip on the left of a race row
  swatch: string; // hex for charts
}

export const TIER_CONFIG: Record<Tier, TierConfig> = {
  SNIPER: {
    label: "SNIPER",
    text: "text-gold-light",
    bg: "bg-gold-light/12",
    border: "border-gold/30",
    strip: "bg-gold-light",
    swatch: "#E8C14A",
  },
  EDGE: {
    label: "EDGE",
    text: "text-gold",
    bg: "bg-gold/10",
    border: "border-gold/30",
    strip: "bg-gold",
    swatch: "#C9A227",
  },
  DUAL: {
    label: "DUAL TOP",
    text: "text-gold-light",
    bg: "bg-gold/10",
    border: "border-gold/30",
    strip: "bg-gold-light",
    swatch: "#E8C14A",
  },
  RECON: {
    label: "RECON",
    text: "text-muted-brand",
    bg: "bg-white/[0.06]",
    border: "border-slate-brand/30",
    strip: "bg-slate-brand",
    swatch: "#8892A0",
  },
  PASS: {
    label: "PASS",
    text: "text-loss",
    bg: "bg-loss/10",
    border: "border-loss/30",
    strip: "bg-loss",
    swatch: "#EF4444",
  },
};

export function tierOf(t: string): TierConfig {
  return TIER_CONFIG[(t as Tier)] ?? TIER_CONFIG.RECON;
}
