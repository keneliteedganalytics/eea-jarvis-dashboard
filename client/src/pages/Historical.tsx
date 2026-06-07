import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { ArchivedCardsGrouped, ArchivedTrackGroup } from "@shared/schema";
import { ScopeLogo } from "@/components/brand/ScopeLogo";
import { Wordmark } from "@/components/brand/Wordmark";
import { Pill } from "@/components/brand/TierPill";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Archive, ChevronRight, ArrowLeft, Calendar } from "lucide-react";

function convictionAccent(c: string | null): string {
  if (c === "HIGH") return "text-gold-light";
  if (c === "MEDIUM") return "text-gold";
  return "text-muted-brand";
}

function ConvictionBadge({ conviction }: { conviction: string | null }) {
  return (
    <span
      className={`inline-flex items-center rounded border border-gold/20 bg-gold/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] font-display font-bold ${convictionAccent(conviction)}`}
      data-testid="badge-conviction"
    >
      {conviction ?? "—"}
    </span>
  );
}

function TrackList({ groups, onSelect }: { groups: ArchivedTrackGroup[]; onSelect: (t: string) => void }) {
  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-gold/10 bg-navy-card p-8 text-center text-slate-brand" data-testid="empty-archive">
        No archived cards yet. Cards are filed here automatically once their race day has passed.
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="track-list">
      {groups.map((g) => {
        const last = g.cards[0]?.date;
        return (
          <button
            key={g.track}
            onClick={() => onSelect(g.track)}
            data-testid={`track-${g.track}`}
            className="group flex items-center justify-between gap-3 rounded-lg border border-gold/10 bg-navy-card p-4 text-left transition-colors hover:border-gold/30 hover:bg-white/[0.03]"
          >
            <div className="min-w-0">
              <div className="font-display font-bold text-silver truncate">{g.track}</div>
              <div className="mt-1 text-[11px] text-muted-brand tabular-nums">
                {g.cards.length} card{g.cards.length === 1 ? "" : "s"} archived
                {last ? ` · latest ${last}` : ""}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-gold-dark transition-transform group-hover:translate-x-0.5" />
          </button>
        );
      })}
    </div>
  );
}

function TrackCards({ group, onBack }: { group: ArchivedTrackGroup; onBack: () => void }) {
  return (
    <div data-testid="track-cards">
      <Button
        variant="ghost"
        onClick={onBack}
        className="mb-3 text-gold hover:bg-gold/10 -ml-2"
        data-testid="button-back-tracks"
      >
        <ArrowLeft className="h-4 w-4 mr-1.5" /> All Tracks
      </Button>
      <div className="text-sm font-display font-bold text-silver mb-3">{group.track}</div>
      <div className="space-y-2">
        {group.cards.map((c) => (
          <Link
            key={c.id}
            href={`/historical/${c.id}`}
            data-testid={`archived-card-${c.id}`}
            className="group flex items-center justify-between gap-3 rounded-lg border border-gold/10 bg-navy-card p-4 transition-colors hover:border-gold/30 hover:bg-white/[0.03]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Calendar className="h-4 w-4 shrink-0 text-gold-dark" />
              <span className="font-display font-bold text-silver tabular-nums">{c.date}</span>
              <span className="text-[11px] text-muted-brand tabular-nums">
                {c.raceCount} race{c.raceCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <ConvictionBadge conviction={c.cardConviction} />
              <ChevronRight className="h-4 w-4 text-gold-dark transition-transform group-hover:translate-x-0.5" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function Historical() {
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const { data, isLoading } = useQuery<ArchivedCardsGrouped>({
    queryKey: ["/api/cards/archived"],
  });

  const groups = data?.tracks ?? [];
  const active = selectedTrack ? groups.find((g) => g.track === selectedTrack) ?? null : null;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      <div className="rounded-xl border border-gold/15 bg-navy-card p-5 sm:p-6">
        <div className="flex items-center gap-4">
          <ScopeLogo size={54} />
          <div>
            <Wordmark />
            <div className="mt-2 flex items-center gap-2">
              <Archive className="h-3.5 w-3.5 text-gold-dark" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-slate-brand">
                HISTORICAL · ARCHIVED CARDS BY TRACK
              </span>
              <Pill>FILED AWAY</Pill>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : active ? (
          <TrackCards group={active} onBack={() => setSelectedTrack(null)} />
        ) : (
          <TrackList groups={groups} onSelect={setSelectedTrack} />
        )}
      </div>
    </div>
  );
}
