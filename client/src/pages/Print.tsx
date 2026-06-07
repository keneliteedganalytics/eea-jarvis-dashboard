import { useEffect, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import "../print.css";

// ── Types for the /print payload ─────────────────────────────────────────
interface BetLeg {
  type: string;
  structure: string;
  horses: string[];
  cost: number;
}
interface RaceBets {
  tier: string;
  raceAllocation: number;
  pass: boolean;
  legs: BetLeg[];
}
interface PrintRace {
  id: number;
  raceNumber: number;
  tier: string;
  post: string | null;
  conditions: string | null;
  shape: string | null;
  read: string | null;
  flags: string;
  winPgm: string | null;
  winName: string | null;
  winScore: number | null;
  placePgm: string | null;
  placeName: string | null;
  placeScore: number | null;
  showPgm: string | null;
  showName: string | null;
  showScore: number | null;
  fourthPgm: string | null;
  fourthName: string | null;
  fourthScore: number | null;
  bets: RaceBets;
  summary: string | null;
}
interface PrintCard {
  id: number;
  track: string;
  date: string;
  races: PrintRace[];
  sizing: {
    bankroll: number;
    dailyRiskCapPct: number;
    dailyCap: number;
    racesOnCard: number;
  };
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function PickRow({
  rank,
  pgm,
  name,
  score,
}: {
  rank: number;
  pgm: string | null;
  name: string | null;
  score: number | null;
}) {
  if (!pgm) return null;
  return (
    <tr>
      <td className="col-num">{rank}</td>
      <td className="col-pgm">#{pgm}</td>
      <td>{name ?? "—"}</td>
      <td className="col-rating">{score != null ? score.toFixed(1) : "—"}</td>
    </tr>
  );
}

function RaceBlock({
  race,
  summary,
  summaryLoading,
}: {
  race: PrintRace;
  summary: string | null;
  summaryLoading: boolean;
}) {
  const flags = JSON.parse(race.flags || "[]") as string[];
  const tier = race.tier.toUpperCase();
  return (
    <div className="print-race">
      <div className="print-race-head">
        <span className="rno">Race {race.raceNumber}</span>
        <span className="cond">
          {race.conditions ?? ""}
          {race.post ? ` · ${race.post}` : ""}
        </span>
        <span className={`tier-badge tier-${tier}`}>{tier}</span>
      </div>

      <table className="print-picks">
        <thead>
          <tr>
            <th className="col-num">#</th>
            <th className="col-pgm">PGM</th>
            <th>Horse</th>
            <th className="col-rating">EEA</th>
          </tr>
        </thead>
        <tbody>
          <PickRow rank={1} pgm={race.winPgm} name={race.winName} score={race.winScore} />
          <PickRow rank={2} pgm={race.placePgm} name={race.placeName} score={race.placeScore} />
          <PickRow rank={3} pgm={race.showPgm} name={race.showName} score={race.showScore} />
          <PickRow rank={4} pgm={race.fourthPgm} name={race.fourthName} score={race.fourthScore} />
        </tbody>
      </table>

      <div className="print-bets">
        <div className="bets-title">
          Recommended Bets
          {!race.bets.pass && race.bets.raceAllocation > 0
            ? ` · ${money(race.bets.raceAllocation)} allocation`
            : ""}
        </div>
        {race.bets.pass || race.bets.legs.length === 0 ? (
          <div className="pass">PASS — no playable edge.</div>
        ) : (
          <ul>
            {race.bets.legs.map((leg, i) => (
              <li key={i}>
                <span>{leg.structure}</span>
                <span>{money(leg.cost)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {flags.length > 0 && (
        <div className="print-summary">
          <span className="label">Flags</span>
          {flags.join(", ")}
        </div>
      )}

      <div className="print-summary">
        <span className="label">Read</span>
        {summaryLoading && !summary ? (
          <span className="skeleton">Generating race summary…</span>
        ) : (
          summary ?? race.read ?? "—"
        )}
      </div>
    </div>
  );
}

export default function Print() {
  const { data: latest } = useQuery<{ id: number }>({
    queryKey: ["/api/cards/latest"],
  });
  const cardId = latest?.id;

  const { data: card, isLoading } = useQuery<PrintCard>({
    queryKey: [`/api/cards/${cardId}/print`],
    enabled: !!cardId,
  });

  const races = card?.races ?? [];

  // Fetch (or generate) each race summary in parallel. The server caches, so
  // re-prints are instant; first print fills in as each one returns.
  const summaryQueries = useQueries({
    queries: races.map((r) => ({
      queryKey: [`race-summary`, r.id],
      enabled: !!card,
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        // Use the cached summary immediately if the print payload already had it.
        if (r.summary) return r.summary;
        const res = await apiRequest("POST", `/api/races/${r.id}/summary`, {});
        const json = (await res.json()) as { summary: string };
        return json.summary;
      },
    })),
  });

  // Auto-open the print dialog once everything has settled.
  const [printed, setPrinted] = useState(false);
  const allSettled =
    !!card && summaryQueries.every((q) => !q.isLoading);
  useEffect(() => {
    if (card && allSettled && !printed) {
      setPrinted(true);
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [card, allSettled, printed]);

  if (isLoading || !card) {
    return (
      <div className="print-page">
        <div className="print-header">
          <h1>Elite Edge Analytics</h1>
          <div className="meta">Loading daily picks…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="print-page">
      <div className="no-print" style={{ marginBottom: 16, textAlign: "right" }}>
        <button
          onClick={() => window.print()}
          style={{
            padding: "8px 16px",
            fontWeight: 700,
            border: "1px solid #111",
            borderRadius: 4,
            background: "#f6c945",
            cursor: "pointer",
          }}
        >
          Print
        </button>
      </div>

      <div className="print-card">
        <div className="print-header">
          <h1>Elite Edge Analytics — {card.track}</h1>
          <div className="meta">
            {card.date} · {races.length} races · Bankroll {money(card.sizing.bankroll)} · Daily
            cap {money(card.sizing.dailyCap)} ({(card.sizing.dailyRiskCapPct * 100).toFixed(1)}%)
          </div>
        </div>

        {races.map((race, i) => (
          <RaceBlock
            key={race.id}
            race={race}
            summary={summaryQueries[i]?.data ?? race.summary}
            summaryLoading={summaryQueries[i]?.isLoading ?? false}
          />
        ))}
      </div>
    </div>
  );
}
