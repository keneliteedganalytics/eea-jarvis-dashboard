import { JARVIS, SCARLETT, type Host } from "@/lib/hosts";

function HeroPortrait({ host }: { host: Host }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gold/20 bg-navy-section shadow-xl">
      <img
        src={host.img}
        alt={host.name}
        width={420}
        height={560}
        loading="eager"
        className="aspect-[3/4] w-full max-w-[clamp(140px,40vw,260px)] object-cover object-top"
      />
    </div>
  );
}

// Paired landing/empty-state hero shown when no card is loaded.
export function HostHero() {
  return (
    <div
      data-testid="hero-landing-paired"
      className="rounded-xl border border-gold/15 bg-navy-card p-6 sm:p-10 text-center"
    >
      <div className="flex items-end justify-center gap-3 sm:gap-6">
        <HeroPortrait host={JARVIS} />
        <HeroPortrait host={SCARLETT} />
      </div>
      <div className="mt-6">
        <div className="font-display font-black text-xl sm:text-2xl tracking-wide">
          <span className="gold-gradient-text">JARVIS &amp; SCARLETT</span>
        </div>
        <p className="mt-2 text-sm text-slate-brand">
          Your Elite Edge handicapping desk.
        </p>
      </div>
    </div>
  );
}
