import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

interface AnalyticsSummary {
  totalCards: number;
  totalRaces: number;
  gradedRaces: number;
  avgWinPct: number;
  roi: number;
  bestTier: string;
  tierHitRates: { tier: string; win: number; place: number; show: number; itm: number }[];
  bankrollCurve: { label: string; cumulative: number }[];
  flagAccuracy: { flag: string; pct: number }[];
  raceTypePerf: { type: string; winPct: number }[];
}

const GOLD = "#C9A227";
const GOLD_LIGHT = "#E8C14A";
const WIN = "#4ADE80";
const SLATE = "#6B7A99";
const LOSS = "#EF4444";

function ChartCard({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">{title}</div>
      <div style={{ width: "100%", height: 240 }}>{children}</div>
      {note && <div className="mt-2 text-[10px] text-muted-brand">{note}</div>}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gold/15 bg-navy-card p-4">
      <div className="text-2xl font-display font-black text-gold-light tabular-nums">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-brand">{label}</div>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: "#0F1F3D",
  border: "1px solid rgba(201,162,39,0.3)",
  borderRadius: 8,
  color: "#DCE8F0",
  fontSize: 12,
};

export default function Analytics() {
  const { data, isLoading } = useQuery<AnalyticsSummary>({ queryKey: ["/api/analytics/summary"] });

  if (isLoading || !data) {
    return <div className="p-6 grid sm:grid-cols-2 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-64 w-full" />)}</div>;
  }

  const sparse = data.gradedRaces <= 1;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      <h1 className="text-xl font-display font-black text-silver">Trends &amp; Analytics</h1>
      {sparse && (
        <div className="mt-2 text-xs text-muted-brand">
          Need more cards to populate trends — showing data from the current card.
        </div>
      )}

      {/* KPI row */}
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Total Cards" value={String(data.totalCards)} />
        <KpiCard label="Total Races" value={String(data.totalRaces)} />
        <KpiCard label="Avg Win %" value={`${data.avgWinPct}%`} />
        <KpiCard label="ROI" value={`${data.roi >= 0 ? "+" : ""}${data.roi}%`} />
        <KpiCard label="Best Tier" value={data.bestTier} />
      </div>

      {/* Charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Hit Rate by Conviction Tier">
          <ResponsiveContainer>
            <BarChart data={data.tierHitRates} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis dataKey="tier" tick={{ fill: SLATE, fontSize: 11 }} />
              <YAxis tick={{ fill: SLATE, fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(201,162,39,0.06)" }} />
              <Legend wrapperStyle={{ fontSize: 11, color: SLATE }} />
              <Bar dataKey="win" name="Win%" fill={GOLD_LIGHT} radius={[3, 3, 0, 0]} />
              <Bar dataKey="place" name="Place%" fill={GOLD} radius={[3, 3, 0, 0]} />
              <Bar dataKey="show" name="Show%" fill={SLATE} radius={[3, 3, 0, 0]} />
              <Bar dataKey="itm" name="ITM%" fill={WIN} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Running ROI / Bankroll Curve">
          <ResponsiveContainer>
            <LineChart data={data.bankrollCurve} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis dataKey="label" tick={{ fill: SLATE, fontSize: 11 }} />
              <YAxis tick={{ fill: SLATE, fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="cumulative" name="Cumulative ($)" stroke={GOLD_LIGHT} strokeWidth={2} dot={{ fill: GOLD, r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Flag Accuracy" note="Share of flagged calls that played out as predicted.">
          <ResponsiveContainer>
            <BarChart data={data.flagAccuracy} layout="vertical" margin={{ top: 4, right: 12, left: 40, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis type="number" tick={{ fill: SLATE, fontSize: 11 }} unit="%" domain={[0, 100]} />
              <YAxis type="category" dataKey="flag" tick={{ fill: SLATE, fontSize: 10 }} width={90} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(201,162,39,0.06)" }} />
              <Bar dataKey="pct" name="Accuracy%" radius={[0, 3, 3, 0]}>
                {data.flagAccuracy.map((f, i) => (
                  <Cell key={i} fill={f.pct >= 50 ? WIN : LOSS} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Race Type Performance">
          <ResponsiveContainer>
            <BarChart data={data.raceTypePerf} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis dataKey="type" tick={{ fill: SLATE, fontSize: 11 }} />
              <YAxis tick={{ fill: SLATE, fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(201,162,39,0.06)" }} />
              <Bar dataKey="winPct" name="Win%" fill={GOLD} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
