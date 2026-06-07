import { cn } from "@/lib/utils";

interface ScopeLogoProps {
  size?: number;
  className?: string;
}

// Scope Reticle brand mark — gold ring, faint inner ring, crosshair arms,
// 12 tick marks (cardinals brighter/longer), center dot.
export function ScopeLogo({ size = 40, className }: ScopeLogoProps) {
  const cx = 50;
  const cy = 50;
  const ticks = [];
  for (let i = 0; i < 12; i++) {
    const angle = (i * 30 * Math.PI) / 180;
    const isCardinal = i % 3 === 0;
    const rOuter = 47;
    const rInner = isCardinal ? 40 : 43;
    const x1 = cx + rOuter * Math.cos(angle);
    const y1 = cy + rOuter * Math.sin(angle);
    const x2 = cx + rInner * Math.cos(angle);
    const y2 = cy + rInner * Math.sin(angle);
    ticks.push(
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="currentColor"
        strokeWidth={isCardinal ? 1.6 : 0.8}
        strokeOpacity={isCardinal ? 0.95 : 0.5}
        strokeLinecap="round"
      />,
    );
  }

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("text-gold", className)}
      aria-label="Elite Edge Analytics scope reticle logo"
      role="img"
    >
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={47} stroke="currentColor" strokeWidth={2.2} fill="none" />
      {/* Faint inner ring at 0.74r */}
      <circle cx={cx} cy={cy} r={37} stroke="currentColor" strokeOpacity={0.3} strokeWidth={0.6} fill="none" />
      {/* Crosshair arms (gap in middle, from 0.30r to 0.86r) */}
      <line x1={7} y1={50} x2={35} y2={50} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <line x1={65} y1={50} x2={93} y2={50} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <line x1={50} y1={7} x2={50} y2={35} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <line x1={50} y1={65} x2={50} y2={93} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* Tick marks */}
      {ticks}
      {/* Center dot */}
      <circle cx={cx} cy={cy} r={1.8} fill="currentColor" />
    </svg>
  );
}
