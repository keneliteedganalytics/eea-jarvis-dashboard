import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ExpertComparisonHeader } from "@/components/ExpertComparisonHeader";

type Scope = "today" | "track" | "lifetime";

interface AnalyticsSummary {
  scope: Scope;
  track: string | null;
  date: string | null;
  totalCards: number;
  totalRaces: number;
  gradedRaces: number;
  avgWinPct: number;
  avgItmPct: number;
  roi: number;
  bestTier: string;
  tierHitRates: { tier: string; win: number; place: number; show: number; itm: number }[];
  bankrollCurve: { label: string; cumulative: number }[];
  flagAccuracy: { flag: string; pct: number }[];
  raceTypePerf: { type: string; winPct: number }[];
}

interface TrackRow {
  track: string;
  cards: number;
  graded: number;
  lastDate: string | null;
}

interface CardListItem {
  id: number;
  track: string;
  date: string;
  status: string;
}

interface LifetimeStats {
  byTrack: { track: string; cards: number; races: number; graded: number; win: number | null; itm: number | null; lastUpdated: string | null }[];
}

interface RoiRow {
  key: string;
  legs: number;
  cost: number;
  payout: number;
  roi: number | null;
  hitRate: number | null;
}
interface LedgerRoi {
  byTier: RoiRow[];
  byPosition: RoiRow[];
  matrix: { tier: string; position: string; roi: number | null; legs: number }[];
  byFlag: RoiRow[];
  overall: RoiRow;
}

// PR #42 analytics tiles
interface TierWeightPerfRow {
  tier: string;
  plannedWeight: number;
  legs: number;
  cost: number;
  payout: number;
  actualRoi: number | null;
  winRate: number | null;
  theoreticalContribution: number | null;
}
interface FlagPerfRow {
  flag: string;
  legs: number;
  cost: number;
  payout: number;
  roi: number | null;
  hitRate: number | null;
}
interface PassWinMissHorse {
  raceNumber: number;
  horseNumber: string;
  name: string | null;
  ourTier: string;
  mlOdds: number | null;
}
interface PassWinMissCard {
  cardId: number;
  track: string;
  date: string;
  count: number;
  horses: PassWinMissHorse[];
}
interface Pr42Analytics {
  tierWeightPerf: TierWeightPerfRow[];
  flagPerf: FlagPerfRow[];
  passWinMisses: PassWinMissCard[];
}

const GOLD = "#C9A227";
const GOLD_LIGHT = "#E8C14A";
const WIN = "#4ADE80";
const SLATE = "#6B7A99";
const LOSS = "#EF4444";

const tooltipStyle = {
  backgroundColor: "#0F1F3D",
  border: "1px solid rgba(201,162,39,0.3)",
  borderRadius: 8,
  color: "#DCE8F0",
  fontSize: 12,
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function ScopeTabs({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  const tabs: { key: Scope; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "track", label: "Per-Track" },
    { key: "lifetime", label: "Lifetime" },
  ];
  return (
    <div className="inline-flex rounded-lg border border-gold/15 bg-navy-card p-1 gap-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={
            "px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] font-display font-bold rounded-md transition-colors " +
            (value === t.key
              ? "bg-gold/15 text-gold-light"
              : "text-muted-brand hover:text-silver")
          }
          data-testid={`scope-tab-${t.key}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ChipStrip({ items, selected, onSelect }: { items: { key: string; label: string; sub?: string }[]; selected: string | null; onSelect: (k: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onSelect(it.key)}
          className={
            "px-3 py-1.5 text-[11px] rounded-md border transition-colors " +
            (selected === it.key
              ? "border-gold/40 bg-gold/10 text-gold-light"
              : "border-gold/10 bg-navy-card text-muted-brand hover:text-silver")
          }
          data-testid={`chip-${it.key.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <span className="font-display font-bold uppercase tracking-[0.1em]">{it.label}</span>
          {it.sub && <span className="ml-2 text-muted-brand tabular-nums">{it.sub}</span>}
        </button>
      ))}
    </div>
  );
}

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

function Charts({ data }: { data: AnalyticsSummary }) {
  const sparse = data.gradedRaces <= 1;
  return (
    <>
      {sparse && (
        <div className="mt-2 text-xs text-muted-brand">
          {data.gradedRaces === 0
            ? "No graded races in this scope yet."
            : "Limited data — only one graded race in this scope."}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Graded" value={String(data.gradedRaces)} />
        <KpiCard label="Win %" value={`${data.avgWinPct}%`} />
        <KpiCard label="ITM %" value={`${data.avgItmPct}%`} />
        <KpiCard label="ROI" value={`${data.roi >= 0 ? "+" : ""}${data.roi}%`} />
        <KpiCard label="Best Tier" value={data.bestTier} />
      </div>

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
    </>
  );
}

function ByTrackTable({ rows }: { rows: LifetimeStats["byTrack"] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-6 rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Lifetime by Track</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-brand uppercase tracking-[0.1em]">
            <tr>
              <th className="text-left py-2">Track</th>
              <th className="text-right py-2">Cards</th>
              <th className="text-right py-2">Races</th>
              <th className="text-right py-2">Graded</th>
              <th className="text-right py-2">Win%</th>
              <th className="text-right py-2">ITM%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.track} className="border-t border-gold/5 text-silver">
                <td className="py-2 font-display font-bold">{r.track}</td>
                <td className="py-2 text-right tabular-nums">{r.cards}</td>
                <td className="py-2 text-right tabular-nums">{r.races}</td>
                <td className="py-2 text-right tabular-nums">{r.graded}</td>
                <td className="py-2 text-right tabular-nums">{r.win == null ? "—" : `${r.win}%`}</td>
                <td className="py-2 text-right tabular-nums">{r.itm == null ? "—" : `${r.itm}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function fmtRoi(roi: number | null): string {
  if (roi == null) return "—";
  return `${roi >= 0 ? "+" : ""}${roi}%`;
}
function roiColor(roi: number | null): string {
  if (roi == null) return "text-muted-brand";
  return roi >= 0 ? "text-win" : "text-loss";
}

function RoiTable({ title, label, rows }: { title: string; label: string; rows: RoiRow[] }) {
  const settled = rows.filter((r) => r.legs > 0);
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">{title}</div>
      {settled.length === 0 ? (
        <div className="text-xs text-muted-brand">No settled legs in this scope yet. Enter payouts on the Results page.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">{label}</th>
                <th className="text-right py-2">Legs</th>
                <th className="text-right py-2">Cost</th>
                <th className="text-right py-2">Payout</th>
                <th className="text-right py-2">ROI</th>
                <th className="text-right py-2">Hit%</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((r) => (
                <tr key={r.key} className="border-t border-gold/5 text-silver" data-testid={`roi-row-${r.key}`}>
                  <td className="py-2 font-display font-bold">{r.key}</td>
                  <td className="py-2 text-right tabular-nums">{r.legs}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(r.cost)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(r.payout)}</td>
                  <td className={`py-2 text-right tabular-nums font-bold ${roiColor(r.roi)}`}>{fmtRoi(r.roi)}</td>
                  <td className="py-2 text-right tabular-nums">{r.hitRate == null ? "—" : `${r.hitRate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RoiMatrix({ cells }: { cells: LedgerRoi["matrix"] }) {
  const tiers = Array.from(new Set(cells.map((c) => c.tier)));
  const positions = Array.from(new Set(cells.map((c) => c.position)));
  const lookup = new Map(cells.map((c) => [`${c.tier}|${c.position}`, c]));
  const anySettled = cells.some((c) => c.legs > 0);
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Tier × Position ROI</div>
      {!anySettled ? (
        <div className="text-xs text-muted-brand">No settled legs in this scope yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">Tier</th>
                {positions.map((p) => <th key={p} className="text-right py-2">{p.slice(0, 4)}</th>)}
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t} className="border-t border-gold/5">
                  <td className="py-2 font-display font-bold text-silver">{t}</td>
                  {positions.map((p) => {
                    const c = lookup.get(`${t}|${p}`);
                    const roi = c && c.legs > 0 ? c.roi : null;
                    return (
                      <td key={p} className={`py-2 text-right tabular-nums ${roiColor(roi)}`} data-testid={`matrix-${t}-${p}`}>
                        {c && c.legs > 0 ? fmtRoi(roi) : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RoiSections({ roi }: { roi: LedgerRoi }) {
  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-display font-black text-silver uppercase tracking-[0.14em]">Strategy ROI</h2>
        <span className={`text-sm font-display font-bold tabular-nums ${roiColor(roi.overall.roi)}`} data-testid="roi-overall">
          Overall {fmtRoi(roi.overall.roi)} · {fmtMoney(roi.overall.payout)} / {fmtMoney(roi.overall.cost)}
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RoiTable title="Tier ROI" label="Tier" rows={roi.byTier} />
        <RoiTable title="Position ROI" label="Position" rows={roi.byPosition} />
      </div>
      <RoiMatrix cells={roi.matrix} />
      <RoiTable title="Flag ROI" label="Flag" rows={roi.byFlag} />
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  ml_favorite_matched: "ML Favorite Matched (+5)",
  speed_gap: "Speed-Gap Demotion",
  field_size_maiden_claim_9plus: "Maiden Claim 9+ Gate",
};

function TierWeightPerf({ rows }: { rows: TierWeightPerfRow[] }) {
  const any = rows.some((r) => r.legs > 0 || r.winRate != null);
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Tier Weight Performance</div>
      {!any ? (
        <div className="text-xs text-muted-brand">No graded tier data in this scope yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">Tier</th>
                <th className="text-right py-2">Weight</th>
                <th className="text-right py-2">Win%</th>
                <th className="text-right py-2">Actual ROI</th>
                <th className="text-right py-2">Theo.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tier} className="border-t border-gold/5 text-silver" data-testid={`tierweight-row-${r.tier}`}>
                  <td className="py-2 font-display font-bold">{r.tier}</td>
                  <td className="py-2 text-right tabular-nums">{r.plannedWeight}</td>
                  <td className="py-2 text-right tabular-nums">{r.winRate == null ? "—" : `${r.winRate}%`}</td>
                  <td className={`py-2 text-right tabular-nums font-bold ${roiColor(r.actualRoi)}`}>{fmtRoi(r.actualRoi)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-brand">{r.theoreticalContribution == null ? "—" : r.theoreticalContribution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlagPerf({ rows }: { rows: FlagPerfRow[] }) {
  const settled = rows.filter((r) => r.legs > 0);
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Flag Performance</div>
      {settled.length === 0 ? (
        <div className="text-xs text-muted-brand">No settled flag legs in this scope yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">Flag</th>
                <th className="text-right py-2">Legs</th>
                <th className="text-right py-2">Cost</th>
                <th className="text-right py-2">Payout</th>
                <th className="text-right py-2">ROI</th>
                <th className="text-right py-2">Hit%</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((r) => (
                <tr key={r.flag} className="border-t border-gold/5 text-silver" data-testid={`flagperf-row-${r.flag}`}>
                  <td className="py-2 font-display font-bold">{FLAG_LABEL[r.flag] ?? r.flag}</td>
                  <td className="py-2 text-right tabular-nums">{r.legs}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(r.cost)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(r.payout)}</td>
                  <td className={`py-2 text-right tabular-nums font-bold ${roiColor(r.roi)}`}>{fmtRoi(r.roi)}</td>
                  <td className="py-2 text-right tabular-nums">{r.hitRate == null ? "—" : `${r.hitRate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PassWinMisses({ cards }: { cards: PassWinMissCard[] }) {
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">PASS-WIN Misses</div>
      {cards.length === 0 ? (
        <div className="text-xs text-muted-brand">No PASS-WIN misses in this scope. Every PASS race's winner was off our board.</div>
      ) : (
        <div className="space-y-3">
          {cards.map((c) => (
            <div key={c.cardId} data-testid={`passwin-card-${c.cardId}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-display font-bold text-silver">{c.track} · {c.date}</span>
                <span className="text-[11px] text-loss font-bold tabular-nums">{c.count} miss{c.count === 1 ? "" : "es"}</span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {c.horses.map((h, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11px] text-muted-brand tabular-nums" data-testid={`passwin-horse-${c.cardId}-${h.raceNumber}`}>
                    <span className="text-gold-dark font-bold">R{h.raceNumber}</span>
                    <span className="text-silver">#{h.horseNumber} {h.name ?? ""}</span>
                    <span className="ml-auto">{h.ourTier}{h.mlOdds != null ? ` · ${h.mlOdds}-1 ML` : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pr42Sections({ data }: { data: Pr42Analytics }) {
  return (
    <div className="mt-6 space-y-4">
      <h2 className="text-sm font-display font-black text-silver uppercase tracking-[0.14em]">PR #42 — Recal &amp; Conviction</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <TierWeightPerf rows={data.tierWeightPerf} />
        <FlagPerf rows={data.flagPerf} />
      </div>
      <PassWinMisses cards={data.passWinMisses} />
    </div>
  );
}

// ── Book Bets (real sportsbook bets) ──────────────────────────────────────
interface BookSummary {
  totalBets: number;
  totalCost: number;
  totalPayout: number;
  totalPnl: number;
  roi: number;
  winPct: number;
}
interface BookGroupRow extends BookSummary {
  track?: string;
  betType?: string;
}
interface BookCurvePoint {
  placedAt: string;
  cumulativePnl: number;
}
interface BookBetRow {
  id: number;
  betId: string;
  placedAt: string;
  date: string;
  track: string;
  race: number;
  betType: string;
  betSubtype: string | null;
  wagerDesc: string;
  baseAmount: number;
  totalCost: number;
  payout: number;
  result: string;
  source: string;
  pnl: number;
  roi: number;
}
interface BookBetsPage {
  total: number;
  limit: number;
  offset: number;
  bets: BookBetRow[];
}

interface ExpertPickApiRow {
  id: number;
  track: string;
  date: string;
  race: number;
  source: string;
  sourceHandicapper: string;
  topPick: number;
  picks24: string; // JSON array string
  result: string | null;
  winner: number | null;
}

function pnlColor(n: number): string {
  return n >= 0 ? "text-win" : "text-loss";
}

function BookKpiCard({ label, value, tone }: { label: string; value: string; tone?: "win" | "loss" | "neutral" }) {
  const valueColor = tone === "win" ? "text-win" : tone === "loss" ? "text-loss" : "text-gold-light";
  return (
    <div className="rounded-lg border border-gold/15 bg-navy-card p-4">
      <div className={`text-2xl font-display font-black tabular-nums ${valueColor}`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-brand">{label}</div>
    </div>
  );
}

// Color-grade an ROI% for the heatmap cell background.
function roiHeatStyle(roi: number | null, legs: number): React.CSSProperties {
  if (legs <= 0 || roi == null) return { background: "transparent" };
  const clamped = Math.max(-100, Math.min(100, roi));
  const alpha = Math.min(0.4, 0.08 + (Math.abs(clamped) / 100) * 0.32);
  const rgb = roi >= 0 ? "74,222,128" : "239,68,68";
  return { background: `rgba(${rgb},${alpha})` };
}

function BookGroupTable({ title, label, rows }: { title: string; label: string; rows: BookGroupRow[] }) {
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-brand">No bets in this range yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">{label}</th>
                <th className="text-right py-2">Bets</th>
                <th className="text-right py-2">Cost</th>
                <th className="text-right py-2">Payout</th>
                <th className="text-right py-2">P/L</th>
                <th className="text-right py-2">ROI</th>
                <th className="text-right py-2">Win%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = r.track ?? r.betType ?? "";
                return (
                  <tr key={key} className="border-t border-gold/5 text-silver" data-testid={`book-group-${key.toLowerCase().replace(/\s+/g, "-")}`}>
                    <td className="py-2 font-display font-bold">{key}</td>
                    <td className="py-2 text-right tabular-nums">{r.totalBets}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(r.totalCost)}</td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(r.totalPayout)}</td>
                    <td className={`py-2 text-right tabular-nums font-bold ${pnlColor(r.totalPnl)}`}>{fmtMoney(r.totalPnl)}</td>
                    <td className={`py-2 text-right tabular-nums ${roiColor(r.roi)}`}>{fmtRoi(r.roi)}</td>
                    <td className="py-2 text-right tabular-nums">{r.winPct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BookMatrix({ cells }: { cells: BookGroupRow[] }) {
  const tracks = Array.from(new Set(cells.map((c) => c.track!)));
  const types = Array.from(new Set(cells.map((c) => c.betType!)));
  const lookup = new Map(cells.map((c) => [`${c.track}|${c.betType}`, c]));
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Track × Bet Type ROI</div>
      {cells.length === 0 ? (
        <div className="text-xs text-muted-brand">No bets in this range yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2 pr-3">Track</th>
                {types.map((t) => <th key={t} className="text-right py-2 px-2">{t}</th>)}
              </tr>
            </thead>
            <tbody>
              {tracks.map((tr) => (
                <tr key={tr} className="border-t border-gold/5">
                  <td className="py-2 pr-3 font-display font-bold text-silver whitespace-nowrap">{tr}</td>
                  {types.map((ty) => {
                    const c = lookup.get(`${tr}|${ty}`);
                    return (
                      <td
                        key={ty}
                        className={`py-2 px-2 text-right tabular-nums ${c ? roiColor(c.roi) : "text-muted-brand"}`}
                        style={roiHeatStyle(c ? c.roi : null, c ? c.totalBets : 0)}
                        data-testid={`book-matrix-${tr.toLowerCase().replace(/\s+/g, "-")}-${ty}`}
                      >
                        {c ? fmtRoi(c.roi) : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BookRecentBets({ rows }: { rows: BookBetRow[] }) {
  const resultClass = (r: string) =>
    r === "WIN" ? "text-win" : r === "LOSS" ? "text-loss" : "text-muted-brand";
  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">Recent Bets</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-brand">No bets ingested yet. Run the seed script or POST to /api/real-bets/bulk-upsert.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-brand uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left py-2">Time</th>
                <th className="text-left py-2">Track</th>
                <th className="text-right py-2">Race</th>
                <th className="text-left py-2">Type</th>
                <th className="text-left py-2">Wager</th>
                <th className="text-right py-2">Cost</th>
                <th className="text-right py-2">Payout</th>
                <th className="text-right py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-t border-gold/5 text-silver" data-testid={`book-bet-${b.betId}`}>
                  <td className="py-2 tabular-nums text-muted-brand whitespace-nowrap">{b.placedAt.replace("T", " ").slice(0, 16)}</td>
                  <td className="py-2 font-display font-bold whitespace-nowrap">{b.track}</td>
                  <td className="py-2 text-right tabular-nums">{b.race}</td>
                  <td className="py-2"><span className="rounded bg-gold/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold font-display font-bold">{b.betType}</span></td>
                  <td className="py-2 text-muted-brand">{b.wagerDesc}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(b.totalCost)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtMoney(b.payout)}</td>
                  <td className={`py-2 text-right tabular-nums font-bold ${resultClass(b.result)}`}>{b.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// By-Race drill-down: our book result for a race alongside the expert's pick.
// Rows where we won and the expert's pick lost (or vice versa) are highlighted.
function BookByRace({ bets, date }: { bets: BookBetRow[]; date?: string }) {
  const { data: experts = [] } = useQuery<ExpertPickApiRow[]>({
    queryKey: [date ? `/api/expert-picks?date=${date}` : "/api/expert-picks"],
  });

  // Index expert rows by track|race (prefer a graded row; first one otherwise).
  const expertByRace = new Map<string, ExpertPickApiRow>();
  for (const e of experts) {
    const k = `${e.track}|${e.race}`;
    const existing = expertByRace.get(k);
    if (!existing || (e.result && !existing.result)) expertByRace.set(k, e);
  }

  // One row per (track, race) we have a book bet on, most recent first.
  const seen = new Set<string>();
  const rows = bets
    .filter((b) => {
      const k = `${b.track}|${b.race}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((b) => {
      const e = expertByRace.get(`${b.track}|${b.race}`);
      const ourWon = b.result === "WIN";
      const expertWon = e?.result === "WIN";
      const divergent = e?.result != null && ourWon !== expertWon;
      return { b, e, ourWon, expertWon, divergent };
    });

  if (rows.length === 0) return null;

  const resultClass = (r: string | null) =>
    r === "WIN" ? "text-win" : r === "OUT" || r === "LOSS" ? "text-loss" : "text-muted-brand";

  return (
    <div className="rounded-lg border border-gold/10 bg-navy-card p-4">
      <div className="text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold mb-3">
        By Race · EEA vs Expert
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-brand uppercase tracking-[0.1em]">
            <tr>
              <th className="text-left py-2">Race</th>
              <th className="text-left py-2">Our Pick</th>
              <th className="text-right py-2">Result</th>
              <th className="text-left py-2">Expert Pick</th>
              <th className="text-left py-2">Expert Source</th>
              <th className="text-right py-2">Winner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, e, divergent }) => (
              <tr
                key={`${b.track}-${b.race}`}
                className={`border-t border-gold/5 text-silver ${divergent ? "bg-gold/[0.06]" : ""}`}
                data-testid={`byrace-${b.track}-${b.race}`}
              >
                <td className="py-2 font-display font-bold whitespace-nowrap">
                  {b.track} R{b.race}
                </td>
                <td className="py-2 tabular-nums text-muted-brand">{b.wagerDesc}</td>
                <td className={`py-2 text-right tabular-nums font-bold ${resultClass(b.result)}`}>
                  {b.result}
                </td>
                <td className="py-2 tabular-nums">{e ? `#${e.topPick}` : "—"}</td>
                <td className="py-2 text-muted-brand whitespace-nowrap">
                  {e?.sourceHandicapper ?? "—"}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {e?.winner != null ? `#${e.winner}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BookBets() {
  const { data: summary } = useQuery<BookSummary>({ queryKey: ["/api/analytics/book/summary"] });
  const { data: byTrack = [] } = useQuery<BookGroupRow[]>({ queryKey: ["/api/analytics/book/by-track"] });
  const { data: byType = [] } = useQuery<BookGroupRow[]>({ queryKey: ["/api/analytics/book/by-bet-type"] });
  const { data: matrix = [] } = useQuery<BookGroupRow[]>({ queryKey: ["/api/analytics/book/by-track-and-type"] });
  const { data: curve = [] } = useQuery<BookCurvePoint[]>({ queryKey: ["/api/analytics/book/bankroll-curve"] });
  const { data: betsPage } = useQuery<BookBetsPage>({ queryKey: ["/api/analytics/book/bets?limit=50"] });

  if (!summary) {
    return (
      <div className="mt-4 grid sm:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
      </div>
    );
  }

  if (summary.totalBets === 0) {
    return (
      <div className="mt-6 rounded-lg border border-gold/10 bg-navy-card p-6 text-center">
        <div className="text-sm text-muted-brand">No book bets ingested yet.</div>
        <div className="mt-1 text-[11px] text-muted-brand">Run <code className="text-gold-dark">npx tsx scripts/seed_real_bets.ts</code> to load Ken's placed bets.</div>
      </div>
    );
  }

  const curveData = curve.map((p) => ({ label: p.placedAt.slice(5, 10), cumulative: p.cumulativePnl }));

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <BookKpiCard label="Total Wagered" value={fmtMoney(summary.totalCost)} />
        <BookKpiCard label="Total Payout" value={fmtMoney(summary.totalPayout)} />
        <BookKpiCard label="P / L" value={fmtMoney(summary.totalPnl)} tone={summary.totalPnl >= 0 ? "win" : "loss"} />
        <BookKpiCard label="ROI" value={fmtRoi(summary.roi)} tone={summary.roi >= 0 ? "win" : "loss"} />
        <BookKpiCard label="Win %" value={`${summary.winPct}%`} />
        <BookKpiCard label="Bet Count" value={String(summary.totalBets)} />
      </div>

      <ChartCard title="Bankroll Curve · Cumulative P/L">
        <ResponsiveContainer>
          <LineChart data={curveData} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
            <XAxis dataKey="label" tick={{ fill: SLATE, fontSize: 11 }} minTickGap={24} />
            <YAxis tick={{ fill: SLATE, fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="cumulative" name="Cumulative P/L ($)" stroke={GOLD_LIGHT} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="P/L by Track">
          <ResponsiveContainer>
            <BarChart data={byTrack} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis dataKey="track" tick={{ fill: SLATE, fontSize: 9 }} interval={0} angle={-20} textAnchor="end" height={60} />
              <YAxis tick={{ fill: SLATE, fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(201,162,39,0.06)" }} />
              <Bar dataKey="totalPnl" name="P/L ($)" radius={[3, 3, 0, 0]}>
                {byTrack.map((r, i) => <Cell key={i} fill={r.totalPnl >= 0 ? WIN : LOSS} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="P/L by Bet Type">
          <ResponsiveContainer>
            <BarChart data={byType} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(108,122,153,0.15)" />
              <XAxis dataKey="betType" tick={{ fill: SLATE, fontSize: 10 }} interval={0} />
              <YAxis tick={{ fill: SLATE, fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(201,162,39,0.06)" }} />
              <Bar dataKey="totalPnl" name="P/L ($)" radius={[3, 3, 0, 0]}>
                {byType.map((r, i) => <Cell key={i} fill={r.totalPnl >= 0 ? WIN : LOSS} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BookGroupTable title="ROI by Track" label="Track" rows={byTrack} />
        <BookGroupTable title="ROI by Bet Type" label="Bet Type" rows={byType} />
      </div>

      <BookMatrix cells={matrix} />
      <BookByRace bets={betsPage?.bets ?? []} />
      <BookRecentBets rows={betsPage?.bets ?? []} />
    </div>
  );
}

function JarvisPicks() {
  const [scope, setScope] = useState<Scope>("today");
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [todaySubTrack, setTodaySubTrack] = useState<string | null>(null);

  const today = todayUtc();

  // Today scope — fetch active cards to detect 0 / 1 / 2+ cards
  const { data: cards = [] } = useQuery<CardListItem[]>({ queryKey: ["/api/cards"] });
  const todayCards = useMemo(
    () => cards.filter((c) => c.date === today && c.status === "active"),
    [cards, today],
  );

  // When entering Today scope with multiple cards, default to first track
  useEffect(() => {
    if (scope === "today" && todayCards.length >= 2 && !todaySubTrack) {
      setTodaySubTrack(todayCards[0].track);
    }
    if (scope === "today" && todayCards.length < 2) {
      setTodaySubTrack(null);
    }
  }, [scope, todayCards, todaySubTrack]);

  // Tracks list for Per-Track scope
  const { data: tracks = [] } = useQuery<TrackRow[]>({ queryKey: ["/api/analytics/tracks"] });
  useEffect(() => {
    if (scope === "track" && !selectedTrack && tracks.length > 0) {
      setSelectedTrack(tracks[0].track);
    }
  }, [scope, selectedTrack, tracks]);

  // Lifetime by-track table data
  const { data: lifetime } = useQuery<LifetimeStats>({
    queryKey: ["/api/stats/lifetime"],
    enabled: scope === "lifetime",
  });

  // Build the actual analytics query for the current scope
  const summaryUrl = useMemo(() => {
    if (scope === "today") {
      if (todayCards.length >= 2 && todaySubTrack) {
        return `/api/analytics/summary?scope=track&track=${encodeURIComponent(todaySubTrack)}&date=${today}`;
      }
      if (todayCards.length === 1) {
        return `/api/analytics/summary?scope=track&track=${encodeURIComponent(todayCards[0].track)}&date=${today}`;
      }
      return `/api/analytics/summary?scope=today`;
    }
    if (scope === "track" && selectedTrack) {
      return `/api/analytics/summary?scope=track&track=${encodeURIComponent(selectedTrack)}`;
    }
    return `/api/analytics/summary?scope=lifetime`;
  }, [scope, todayCards, todaySubTrack, selectedTrack, today]);

  const { data, isLoading } = useQuery<AnalyticsSummary>({ queryKey: [summaryUrl] });

  // Parallel ROI query — mirrors the scope logic of summaryUrl against /api/analytics/roi
  const roiUrl = useMemo(() => {
    if (scope === "today") {
      if (todayCards.length >= 2 && todaySubTrack) {
        return `/api/analytics/roi?scope=track&track=${encodeURIComponent(todaySubTrack)}&date=${today}`;
      }
      if (todayCards.length === 1) {
        return `/api/analytics/roi?scope=track&track=${encodeURIComponent(todayCards[0].track)}&date=${today}`;
      }
      return `/api/analytics/roi?scope=today`;
    }
    if (scope === "track" && selectedTrack) {
      return `/api/analytics/roi?scope=track&track=${encodeURIComponent(selectedTrack)}`;
    }
    return `/api/analytics/roi?scope=lifetime`;
  }, [scope, todayCards, todaySubTrack, selectedTrack, today]);

  const { data: roi } = useQuery<LedgerRoi>({ queryKey: [roiUrl] });

  // PR #42 tiles — same scope logic as roiUrl against /api/analytics/pr42
  const pr42Url = useMemo(() => roiUrl.replace("/api/analytics/roi", "/api/analytics/pr42"), [roiUrl]);
  const { data: pr42 } = useQuery<Pr42Analytics>({ queryKey: [pr42Url] });

  const scopeLabel = useMemo(() => {
    if (scope === "today") {
      if (todayCards.length >= 2 && todaySubTrack) return `Today · ${todaySubTrack}`;
      if (todayCards.length === 1) return `Today · ${todayCards[0].track}`;
      return "Today";
    }
    if (scope === "track") return `${selectedTrack ?? "Pick a track"} · All-Time`;
    return "Lifetime · All Tracks";
  }, [scope, todayCards, todaySubTrack, selectedTrack]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-gold-dark font-display font-bold">
          Showing: {scopeLabel}
        </div>
        <ScopeTabs value={scope} onChange={setScope} />
      </div>

      {scope === "today" && todayCards.length === 0 && (
        <div className="mt-6 rounded-lg border border-gold/10 bg-navy-card p-6 text-center">
          <div className="text-sm text-muted-brand">No active cards today.</div>
          <div className="mt-1 text-[11px] text-muted-brand">Pull a card from the Home page to start handicapping.</div>
        </div>
      )}

      {scope === "today" && todayCards.length >= 2 && (
        <div className="mt-4">
          <ChipStrip
            items={todayCards.map((c) => ({ key: c.track, label: c.track }))}
            selected={todaySubTrack}
            onSelect={setTodaySubTrack}
          />
        </div>
      )}

      {scope === "track" && (
        <div className="mt-4">
          <ChipStrip
            items={tracks.map((t) => ({
              key: t.track,
              label: t.track,
              sub: `${t.graded}g`,
            }))}
            selected={selectedTrack}
            onSelect={setSelectedTrack}
          />
        </div>
      )}

      {(scope !== "today" || todayCards.length > 0) && (
        <>
          {isLoading || !data ? (
            <div className="mt-4 grid sm:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-64 w-full" />)}
            </div>
          ) : (
            <>
              <Charts data={data} />
              {roi && <RoiSections roi={roi} />}
              {pr42 && <Pr42Sections data={pr42} />}
            </>
          )}
        </>
      )}

      {scope === "lifetime" && lifetime && <ByTrackTable rows={lifetime.byTrack} />}
    </div>
  );
}

export default function Analytics() {
  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto pb-28">
      <h1 className="text-xl font-display font-black text-silver">Trends &amp; Analytics</h1>
      <div className="mt-3">
        <ExpertComparisonHeader track="ALL" />
      </div>
      <Tabs defaultValue="jarvis" className="mt-3">
        <TabsList className="bg-navy-card border border-gold/15">
          <TabsTrigger
            value="jarvis"
            className="data-[state=active]:bg-gold/15 data-[state=active]:text-gold-light text-muted-brand uppercase tracking-[0.12em] text-[11px] font-display font-bold"
            data-testid="tab-jarvis-picks"
          >
            Jarvis Picks
          </TabsTrigger>
          <TabsTrigger
            value="book"
            className="data-[state=active]:bg-gold/15 data-[state=active]:text-gold-light text-muted-brand uppercase tracking-[0.12em] text-[11px] font-display font-bold"
            data-testid="tab-book-bets"
          >
            Book Bets
          </TabsTrigger>
        </TabsList>
        <TabsContent value="jarvis">
          <JarvisPicks />
        </TabsContent>
        <TabsContent value="book">
          <BookBets />
        </TabsContent>
      </Tabs>
    </div>
  );
}
