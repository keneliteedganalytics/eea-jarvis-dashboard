import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { JARVIS, SCARLETT, type Host } from "@/lib/hosts";

function HostCard({ host, testid }: { host: Host; testid: string }) {
  return (
    <div className="rounded-xl border border-gold/15 bg-navy-card p-5 sm:p-6">
      <div className="overflow-hidden rounded-lg border border-gold/20 bg-navy-section">
        <img
          src={host.img}
          alt={`${host.name} — Elite Edge Analytics host`}
          width={600}
          height={800}
          loading="lazy"
          data-testid={testid}
          className="aspect-[3/4] w-full object-cover object-top"
        />
      </div>
      <div className="mt-4">
        <div className="font-display font-black text-xl text-gold-light">{host.name}</div>
        <p className="mt-2 text-sm leading-relaxed text-slate-brand">{host.bio}</p>
      </div>
    </div>
  );
}

// Small horse-pin glyph for the brand strip.
function HorsePin({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="text-gold"
      role="img"
      aria-label="Elite Edge horse pin"
    >
      <path
        fill="currentColor"
        d="M5 21c-.4-3 .5-5.6 2.4-7.6L6 11.7c-.5.3-1.1.5-1.8.5L3 12V10l1.2.1c.5 0 1-.2 1.3-.6l1.7-2.1c.6-.8 1.6-1.3 2.6-1.3h.7l1-1.6c.2-.4.7-.6 1.1-.4l.6.3-.6 1.6 2 .9c1.4.6 2.4 1.9 2.7 3.4l.9 4.6c.1.6.4 1.1.9 1.5l.6.5-1.3 1.5-.7-.6c-.8-.7-1.4-1.6-1.6-2.7l-.5-2.6-1.6 1.4c-.6.5-.9 1.2-.9 2V21h-2v-2.7c0-1.3.6-2.6 1.6-3.5l.6-.5-.4-2c-.1-.6-.5-1.1-1.1-1.4l-1-.4-2 2.5c-1.6 2-2.1 4.6-1.4 7.1l.1.3H5z"
      />
    </svg>
  );
}

export default function About() {
  return (
    <div className="p-4 sm:p-6 max-w-[1100px] mx-auto pb-28">
      <div className="flex items-center gap-4">
        <ScopeLogo size={44} />
        <div>
          <Wordmark />
          <h1 className="mt-2 font-display font-black text-2xl text-silver">Meet the Team</h1>
        </div>
      </div>

      <p className="mt-3 max-w-2xl text-sm text-muted-brand">
        Your Elite Edge handicapping desk — two voices on every card, from the morning line to the
        final recap.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <HostCard host={JARVIS} testid="img-host-jarvis" />
        <HostCard host={SCARLETT} testid="img-host-scarlett" />
      </div>

      {/* Brand strip */}
      <div className="mt-10 flex items-center gap-4" data-testid="about-brand-strip">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gold/40 to-gold/40" />
        <HorsePin />
        <div className="h-px flex-1 bg-gradient-to-l from-transparent via-gold/40 to-gold/40" />
      </div>
    </div>
  );
}
