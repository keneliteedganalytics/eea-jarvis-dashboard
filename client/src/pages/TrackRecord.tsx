import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";

// Public track-record contract — mirrors GET /api/public/track-record
// (server/routes.ts). Aggregate-only: no picks, no horse names, no race detail.
interface TrackRow {
  track: string;
  cards: number;
  races: number;
  graded: number;
  win: number | null;
  itm: number | null;
  lastUpdated: string | null;
}
interface PublicTrackRecord {
  totals: {
    cards: number;
    races: number;
    graded: number;
    win: number | null;
    place: number | null;
    show: number | null;
    itm: number | null;
  };
  byTrack: TrackRow[];
  generatedAt: string;
}

const PAGE_TITLE = "EEA Jarvis · Track Record";
const PAGE_DESC =
  "Public, time-stamped horse racing handicapping track record. Every card, every miss, every postmortem.";
const OG_IMAGE = "/og-track-record.svg";

function pctVal(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

// SEO + social meta, applied imperatively so the public page is crawlable and
// shares cleanly on Twitter without an SSR layer.
function useTrackRecordHead() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = PAGE_TITLE;

    const setMeta = (selector: string, attr: "name" | "property", key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(selector);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attr, key);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
      return el;
    };

    setMeta('meta[name="description"]', "name", "description", PAGE_DESC);
    setMeta('meta[name="robots"]', "name", "robots", "index, follow");
    setMeta('meta[property="og:title"]', "property", "og:title", PAGE_TITLE);
    setMeta('meta[property="og:description"]', "property", "og:description", PAGE_DESC);
    setMeta('meta[property="og:type"]', "property", "og:type", "website");
    setMeta('meta[property="og:image"]', "property", "og:image", OG_IMAGE);
    setMeta('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", PAGE_TITLE);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", PAGE_DESC);
    setMeta('meta[name="twitter:image"]', "name", "twitter:image", OG_IMAGE);

    return () => {
      document.title = prevTitle;
    };
  }, []);
}

function BannerStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center sm:items-start">
      <span className="font-display font-black tabular-nums text-3xl sm:text-4xl text-gold-light leading-none antialiased">
        {value}
      </span>
      <span className="mt-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-muted-brand">
        {label}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-display font-bold uppercase tracking-[0.2em] text-gold-dark">
      {children}
    </h2>
  );
}

function TrackCard({ row }: { row: TrackRow }) {
  return (
    <div className="rounded-lg border border-gold/12 bg-navy-card p-4 transition-colors hover:border-gold/25">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display font-bold text-silver truncate">{row.track}</span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-brand shrink-0 tabular-nums">
          {row.lastUpdated ?? "—"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2">
        {[
          { v: String(row.cards), l: "Cards" },
          { v: String(row.races), l: "Races" },
          { v: pctVal(row.win), l: "Win" },
          { v: pctVal(row.itm), l: "ITM" },
        ].map((s) => (
          <div key={s.l} className="text-center">
            <div className="font-display font-black tabular-nums text-lg text-gold-light antialiased">
              {s.v}
            </div>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-muted-brand">
              {s.l}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TrackRecord() {
  useTrackRecordHead();
  const { data, isLoading, isError } = useQuery<PublicTrackRecord>({
    queryKey: ["/api/public/track-record"],
  });

  const t = data?.totals;

  return (
    <div className="min-h-screen bg-navy-bg text-silver">
      <div className="mx-auto max-w-[1100px] px-5 py-8 sm:px-8 sm:py-12 pb-20">
        {/* ── Hero ───────────────────────────────────────────────────────── */}
        <header className="flex items-center gap-3">
          <ScopeLogo size={40} />
          <Wordmark />
        </header>

        <div className="mt-10 sm:mt-12">
          <h1 className="font-display font-black text-3xl sm:text-5xl leading-[1.05] text-silver antialiased">
            Every pick. Every postmortem. Public.
          </h1>
          <p className="mt-4 max-w-2xl text-sm sm:text-base leading-relaxed text-slate-brand">
            EEA Jarvis is an AI-powered handicapping engine. Here's the unfiltered record.
          </p>
        </div>

        {/* Lifetime stats banner */}
        <div
          className="mt-8 rounded-xl border border-gold/15 bg-navy-card px-5 py-6 sm:px-8 sm:py-7"
          data-testid="track-record-banner"
        >
          {isLoading ? (
            <div className="text-sm text-muted-brand">Loading lifetime record…</div>
          ) : isError || !t ? (
            <div className="text-sm text-loss">Lifetime record temporarily unavailable.</div>
          ) : (
            <div className="grid grid-cols-2 gap-6 sm:flex sm:items-end sm:gap-12">
              <BannerStat value={String(t.cards)} label="Cards" />
              <BannerStat value={String(t.races)} label="Races" />
              <BannerStat value={pctVal(t.win)} label="Win" />
              <BannerStat value={pctVal(t.itm)} label="ITM" />
            </div>
          )}
        </div>

        {/* ── By-track breakdown ─────────────────────────────────────────── */}
        <section className="mt-14">
          <SectionTitle>By Track</SectionTitle>
          {data && data.byTrack.length > 0 ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.byTrack.map((row) => (
                <TrackCard key={row.track} row={row} />
              ))}
            </div>
          ) : (
            !isLoading && (
              <p className="mt-4 text-sm text-muted-brand">No graded cards yet.</p>
            )
          )}
        </section>

        {/* ── Methodology ────────────────────────────────────────────────── */}
        <section className="mt-14 max-w-3xl">
          <SectionTitle>Methodology</SectionTitle>
          <div className="mt-4 space-y-4 text-sm sm:text-[15px] leading-relaxed text-slate-brand">
            <p>
              Every race is graded into a single conviction tier. Tiers run, highest to lowest:{" "}
              <span className="text-gold-light font-semibold">SNIPER</span>,{" "}
              <span className="text-gold-light font-semibold">EDGE</span>,{" "}
              <span className="text-gold-light font-semibold">DUAL</span>,{" "}
              <span className="text-gold-light font-semibold">RECON</span>, and{" "}
              <span className="text-gold-light font-semibold">PASS</span>.
            </p>
            <p>
              <span className="text-silver font-semibold">SNIPER</span> is maximum conviction — the
              engine and the fundamentals agree and the price is right.{" "}
              <span className="text-silver font-semibold">EDGE</span> is a strong, actionable read.{" "}
              <span className="text-silver font-semibold">DUAL</span> spreads across two live
              contenders.{" "}
              <span className="text-silver font-semibold">RECON</span> is a small, exploratory
              position. <span className="text-silver font-semibold">PASS</span> means no bet — and
              we log every pass, because discipline is part of the record.
            </p>
            <p>
              The engine is postmortem-driven. When we miss, we run a postmortem the same night and
              ship fixes before the next card — tightening tier flips, demoting on adverse flags, and
              correcting longshot handling (see{" "}
              <a
                href="https://github.com/keneliteedganalytics/eea-jarvis-dashboard/pull/12"
                className="text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold"
                target="_blank"
                rel="noopener noreferrer"
              >
                PR #12
              </a>{" "}
              for a recent self-correction). The model that graded last week is not the model grading
              tonight.
            </p>
          </div>
        </section>

        {/* ── Trust ──────────────────────────────────────────────────────── */}
        <section className="mt-14 max-w-3xl">
          <SectionTitle>What You're Not Seeing Here</SectionTitle>
          <ul className="mt-4 space-y-2 text-sm sm:text-[15px] leading-relaxed text-slate-brand">
            <li className="flex gap-3">
              <span className="text-loss shrink-0">✕</span>
              <span>Today's picks — those are the paid product.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-loss shrink-0">✕</span>
              <span>Race-level detail and horse names — also the paid product.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-gold shrink-0">✓</span>
              <span>
                Every miss, every losing card, every postmortem. The aggregate record above includes
                the bad nights, not just the good ones.
              </span>
            </li>
          </ul>

          <p className="mt-8 text-xs leading-relaxed text-muted-brand">
            Past results don't guarantee future returns. Wagering involves risk; bet within your
            means. Stats are computed from time-stamped, graded results and refresh on page load.
          </p>
          <p className="mt-3 text-xs text-muted-brand">
            Inquiries:{" "}
            <a
              href="mailto:ken@elite-edge-analytics.com"
              className="text-gold underline decoration-gold/40 underline-offset-2 hover:decoration-gold"
            >
              ken@elite-edge-analytics.com
            </a>
          </p>
        </section>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="mt-16 border-t border-gold/10 pt-6">
          <div className="flex flex-col gap-1 text-[11px] text-muted-brand sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} Elite Edge Analytics. All rights reserved.</span>
            <span className="tabular-nums">
              {data?.generatedAt
                ? `Updated ${new Date(data.generatedAt).toISOString().slice(0, 10)}`
                : ""}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
