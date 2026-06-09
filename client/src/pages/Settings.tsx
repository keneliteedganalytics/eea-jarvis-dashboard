import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Settings as SettingsType } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useJarvis } from "@/lib/jarvis";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Mic, Save, Check, X } from "lucide-react";
import type { TuningProposal } from "@shared/schema";

const PREMADE_VOICES = [
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", desc: "Steady Broadcaster (British)" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", desc: "Deep, Resonant Sportscaster (American)" },
  { id: "pqHfZKP75CvOlQylNhV4", name: "Bill", desc: "Wise, Mature Veteran (American)" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", desc: "Warm Storyteller (British)" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", desc: "Dominant, Firm (American)" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", desc: "Laid-Back, Casual (American)" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", desc: "Deep, Confident (Australian)" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", desc: "Energetic, Young (American)" },
];

interface LiveVoice { id: string; name: string; desc: string }

// ── PR #40: budgeted allocator config (tier weights + leg patterns) ─────────
const ROI_TIERS = ["SNIPER", "EDGE", "DUAL", "RECON", "PASS"] as const;
type RoiTier = (typeof ROI_TIERS)[number];
const LEG_KEYS = ["win", "place", "show", "exacta", "trifecta", "superfecta"] as const;
type LegKey = (typeof LEG_KEYS)[number];

const DEFAULT_TIER_WEIGHTS: Record<RoiTier, number> = {
  SNIPER: 30, EDGE: 18, DUAL: 10, RECON: 4, PASS: 0,
};
const DEFAULT_LEG_PATTERNS: Record<RoiTier, Record<LegKey, number>> = {
  SNIPER: { win: 50, place: 20, show: 0, exacta: 15, trifecta: 15, superfecta: 0 },
  EDGE: { win: 45, place: 25, show: 0, exacta: 30, trifecta: 0, superfecta: 0 },
  DUAL: { win: 35, place: 30, show: 20, exacta: 15, trifecta: 0, superfecta: 0 },
  RECON: { win: 100, place: 0, show: 0, exacta: 0, trifecta: 0, superfecta: 0 },
  PASS: { win: 0, place: 0, show: 0, exacta: 0, trifecta: 0, superfecta: 0 },
};

function parseTierWeights(json: string | undefined): Record<RoiTier, number> {
  const out = { ...DEFAULT_TIER_WEIGHTS };
  try {
    const p = JSON.parse(json || "{}");
    for (const t of ROI_TIERS) if (typeof p[t] === "number") out[t] = p[t];
  } catch { /* defaults */ }
  return out;
}
function parseLegPatterns(json: string | undefined): Record<RoiTier, Record<LegKey, number>> {
  const out: Record<RoiTier, Record<LegKey, number>> = JSON.parse(JSON.stringify(DEFAULT_LEG_PATTERNS));
  try {
    const p = JSON.parse(json || "{}");
    for (const t of ROI_TIERS) {
      if (p[t] && typeof p[t] === "object") {
        for (const k of LEG_KEYS) if (typeof p[t][k] === "number") out[t][k] = p[t][k];
      }
    }
  } catch { /* defaults */ }
  return out;
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gold/15 bg-navy-card p-5">
      <div className="text-sm font-display font-bold text-silver">{title}</div>
      {desc && <div className="text-xs text-muted-brand mt-0.5">{desc}</div>}
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">{label}</label>
      {children}
    </div>
  );
}

function TuningInbox() {
  const { toast } = useToast();
  const { data: proposals } = useQuery<TuningProposal[]>({ queryKey: ["/api/tuning-proposals"] });

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "accept" | "reject" }) => {
      await apiRequest("POST", `/api/tuning-proposals/${id}/${action}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tuning-proposals"] });
      toast({ title: "Proposal updated" });
    },
    onError: (e) => toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" }),
  });

  if (!proposals || proposals.length === 0) {
    return (
      <Section title="Auto-Tuner Proposals" desc="Surfaces when the engine drifts from its baselines">
        <div className="text-xs text-muted-brand">No pending proposals — the engine is tracking to plan.</div>
      </Section>
    );
  }

  return (
    <Section title={`Auto-Tuner Proposals (${proposals.length})`} desc="Review evidence, then accept or reject">
      <div className="space-y-3">
        {proposals.map((p) => (
          <div key={p.id} className="rounded-md border border-gold/15 bg-navy-section p-3" data-testid={`proposal-${p.id}`}>
            <div className="text-[12px] text-silver">{p.hypothesis}</div>
            <pre className="mt-1.5 overflow-x-auto rounded bg-navy-bg/60 p-2 text-[10px] text-muted-brand">{p.evidenceJson}</pre>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => act.mutate({ id: p.id, action: "accept" })} disabled={act.isPending} className="bg-win/80 hover:bg-win text-navy-bg" data-testid={`button-accept-${p.id}`}>
                <Check className="h-3.5 w-3.5 mr-1" /> Accept
              </Button>
              <Button size="sm" variant="outline" onClick={() => act.mutate({ id: p.id, action: "reject" })} disabled={act.isPending} className="border-loss/40 text-loss hover:bg-loss/10" data-testid={`button-reject-${p.id}`}>
                <X className="h-3.5 w-3.5 mr-1" /> Reject
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function Settings() {
  const { data: settings, isLoading } = useQuery<SettingsType>({ queryKey: ["/api/settings"] });
  const { data: liveVoices } = useQuery<LiveVoice[]>({ queryKey: ["/api/voices"], retry: false });
  const { toast } = useToast();
  const jarvis = useJarvis();
  const [form, setForm] = useState<Partial<SettingsType>>({});
  const [tierWeights, setTierWeights] = useState<Record<RoiTier, number>>(DEFAULT_TIER_WEIGHTS);
  const [legPatterns, setLegPatterns] = useState<Record<RoiTier, Record<LegKey, number>>>(DEFAULT_LEG_PATTERNS);

  useEffect(() => {
    if (settings) {
      setForm(settings);
      setTierWeights(parseTierWeights(settings.tierWeightsJson));
      setLegPatterns(parseLegPatterns(settings.legPatternsJson));
    }
  }, [settings]);

  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const resetAllocatorDefaults = () => {
    setTierWeights({ ...DEFAULT_TIER_WEIGHTS });
    setLegPatterns(JSON.parse(JSON.stringify(DEFAULT_LEG_PATTERNS)));
    setForm((f) => ({ ...f, dailyRiskBudget: 1000, chaosDemotionMode: "floor-recon" }));
  };

  const weightSum = ROI_TIERS.reduce((a, t) => a + (tierWeights[t] || 0), 0);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        tierWeightsJson: JSON.stringify(tierWeights),
        legPatternsJson: JSON.stringify(legPatterns),
      };
      await apiRequest("PATCH", "/api/settings", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved" });
    },
  });

  const testVoice = useMutation({
    mutationFn: async () => {
      // Persist current voice/model first so test uses them.
      await apiRequest("PATCH", "/api/settings", form);
      const res = await apiRequest("POST", "/api/jarvis/speak", {
        text: "Jarvis online. Elite Edge Analytics Sniper Series, ready when you are.",
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      if (data.audioUrl) jarvis.play({ src: data.audioUrl, label: "Voice test" });
    },
    onError: (e: any) => toast({ title: "Test failed", description: e.message?.slice(0, 160), variant: "destructive" }),
  });

  if (isLoading || !form.id) {
    return <div className="p-6 space-y-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full" />)}</div>;
  }

  const voiceOptions: LiveVoice[] = (liveVoices && liveVoices.length ? liveVoices : PREMADE_VOICES);

  return (
    <div className="p-4 sm:p-6 max-w-[820px] mx-auto pb-28">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-display font-black text-silver">Settings</h1>
        <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold" data-testid="button-save-settings">
          <Save className="h-4 w-4 mr-1.5" /> Save
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {/* Bankroll */}
        <Section title="Bankroll &amp; Staking">
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Bankroll ($)">
              <Input type="number" value={form.bankroll ?? 0} onChange={(e) => set("bankroll", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-bankroll" />
            </Field>
            <Field label="Unit Size ($)">
              <Input type="number" value={form.unitSize ?? 0} onChange={(e) => set("unitSize", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-unit" />
            </Field>
            <Field label="Default Track">
              <Input value={form.defaultTrack ?? ""} onChange={(e) => set("defaultTrack", e.target.value)} className="bg-navy-section border-gold/15 text-silver" data-testid="input-track" />
            </Field>
          </div>
        </Section>

        {/* LLM provider + keys */}
        <Section title="LLM Handicapping Engine" desc="API keys live server-side; leave blank to use the server's .env">
          <Field label="Default Provider">
            <Select value={form.defaultLlmProvider} onValueChange={(v) => set("defaultLlmProvider", v)}>
              <SelectTrigger className="bg-navy-section border-gold/15 text-silver" data-testid="select-llm-provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="poe">Poe</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Anthropic Model">
              <Input value={form.defaultAnthropicModel ?? ""} onChange={(e) => set("defaultAnthropicModel", e.target.value)} className="bg-navy-section border-gold/15 text-silver" data-testid="input-anthropic-model" />
            </Field>
            <Field label="Poe Model">
              <Input value={form.defaultPoeModel ?? ""} onChange={(e) => set("defaultPoeModel", e.target.value)} className="bg-navy-section border-gold/15 text-silver" data-testid="input-poe-model" />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Anthropic API Key">
              <Input type="password" value={form.anthropicApiKey ?? ""} placeholder="sk-ant-… (or set in .env)" onChange={(e) => set("anthropicApiKey", e.target.value)} className="bg-navy-section border-gold/15 text-silver" data-testid="input-anthropic-key" />
            </Field>
            <Field label="Poe API Key">
              <Input type="password" value={form.poeApiKey ?? ""} placeholder="sk-poe-… (or set in .env)" onChange={(e) => set("poeApiKey", e.target.value)} className="bg-navy-section border-gold/15 text-silver" data-testid="input-poe-key" />
            </Field>
          </div>
        </Section>

        {/* Risk cap + tier shares */}
        <Section title="Risk &amp; Tier Sizing" desc="Daily risk cap as % of bankroll; tier shares slice that cap">
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Daily Risk Cap (%)">
              <Input type="number" step="0.01" value={form.dailyRiskCapPct ?? 0} onChange={(e) => set("dailyRiskCapPct", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-risk-cap" />
            </Field>
            <Field label="Sniper Share"><Input type="number" step="0.01" value={form.tierShareSniper ?? 0} onChange={(e) => set("tierShareSniper", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-share-sniper" /></Field>
            <Field label="Edge Share"><Input type="number" step="0.01" value={form.tierShareEdge ?? 0} onChange={(e) => set("tierShareEdge", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-share-edge" /></Field>
            <Field label="Dual Share"><Input type="number" step="0.01" value={form.tierShareDual ?? 0} onChange={(e) => set("tierShareDual", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-share-dual" /></Field>
            <Field label="Recon Share"><Input type="number" step="0.01" value={form.tierShareRecon ?? 0} onChange={(e) => set("tierShareRecon", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-share-recon" /></Field>
          </div>
        </Section>

        {/* PR #40: $1k daily risk budget + tier-weighted allocator */}
        <Section title="Daily Risk Budget &amp; Allocator" desc="Tier-weighted $1k/day allocator for NEW cards. Historical cards keep their legacy bets.">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Daily Risk Budget ($)">
              <Input type="number" step="50" value={form.dailyRiskBudget ?? 1000} onChange={(e) => set("dailyRiskBudget", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-daily-budget" />
            </Field>
            <Field label="Chaos Demotion Mode">
              <Select value={form.chaosDemotionMode ?? "floor-recon"} onValueChange={(v) => set("chaosDemotionMode", v)}>
                <SelectTrigger className="bg-navy-section border-gold/15 text-silver" data-testid="select-chaos-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="floor-recon">Floor RECON (default)</SelectItem>
                  <SelectItem value="aggressive">Aggressive (RECON→PASS)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Tier weights */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">Tier Weights</label>
              <span className={`text-[10px] tabular-nums ${weightSum > 100 ? "text-loss" : "text-muted-brand"}`} data-testid="weight-sum">
                sum {weightSum}{weightSum > 100 ? " — exceeds 100" : ""}
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {ROI_TIERS.map((t) => (
                <div key={t} className="flex flex-col gap-1">
                  <span className="text-[9px] uppercase tracking-wide text-muted-brand text-center">{t}</span>
                  <Input
                    type="number"
                    value={tierWeights[t]}
                    onChange={(e) => setTierWeights((w) => ({ ...w, [t]: parseFloat(e.target.value) || 0 }))}
                    className="bg-navy-section border-gold/15 text-silver tabular-nums text-center text-xs h-8"
                    data-testid={`weight-${t}`}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Leg patterns per tier */}
          <div>
            <label className="text-[10px] uppercase tracking-[0.16em] text-gold-dark font-display font-bold">Leg Patterns (% of race budget)</label>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-brand uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left py-1.5">Tier</th>
                    {LEG_KEYS.map((k) => <th key={k} className="text-center py-1.5">{k.slice(0, 4)}</th>)}
                    <th className="text-right py-1.5">Σ</th>
                  </tr>
                </thead>
                <tbody>
                  {ROI_TIERS.filter((t) => t !== "PASS").map((t) => {
                    const rowSum = LEG_KEYS.reduce((a, k) => a + (legPatterns[t][k] || 0), 0);
                    return (
                      <tr key={t} className="border-t border-gold/5">
                        <td className="py-1.5 font-display font-bold text-silver">{t}</td>
                        {LEG_KEYS.map((k) => (
                          <td key={k} className="py-1 px-0.5">
                            <Input
                              type="number"
                              value={legPatterns[t][k]}
                              onChange={(e) => setLegPatterns((p) => ({ ...p, [t]: { ...p[t], [k]: parseFloat(e.target.value) || 0 } }))}
                              className="bg-navy-section border-gold/15 text-silver tabular-nums text-center text-xs h-8 w-14 mx-auto"
                              data-testid={`pattern-${t}-${k}`}
                            />
                          </td>
                        ))}
                        <td className={`py-1.5 text-right tabular-nums ${rowSum === 100 ? "text-win" : "text-loss"}`} data-testid={`pattern-sum-${t}`}>{rowSum}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[10px] text-muted-brand">Each tier row should sum to 100%. Rows that don't are flagged in red.</div>
          </div>

          <Button onClick={resetAllocatorDefaults} variant="outline" className="border-gold/30 text-gold hover:bg-gold/10" data-testid="button-reset-allocator">
            Reset to defaults
          </Button>
        </Section>

        {/* Auto-tuner proposals */}
        <TuningInbox />

        {/* Wager amounts per tier */}
        <Section title="Wager Amounts by Tier">
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Sniper Win"><Input type="number" value={form.sniperWin ?? 0} onChange={(e) => set("sniperWin", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-sniper-win" /></Field>
            <Field label="Sniper Place"><Input type="number" value={form.sniperPlace ?? 0} onChange={(e) => set("sniperPlace", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-sniper-place" /></Field>
            <Field label="Edge Win"><Input type="number" value={form.edgeWin ?? 0} onChange={(e) => set("edgeWin", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-edge-win" /></Field>
            <Field label="Edge Place"><Input type="number" value={form.edgePlace ?? 0} onChange={(e) => set("edgePlace", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-edge-place" /></Field>
            <Field label="Recon Win"><Input type="number" value={form.reconWin ?? 0} onChange={(e) => set("reconWin", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-recon-win" /></Field>
            <Field label="Dual Win (each)"><Input type="number" value={form.dualWin ?? 0} onChange={(e) => set("dualWin", parseFloat(e.target.value) || 0)} className="bg-navy-section border-gold/15 text-silver tabular-nums" data-testid="input-dual-win" /></Field>
          </div>
        </Section>

        {/* Jarvis voice */}
        <Section title="Jarvis Voice" desc="Powered by ElevenLabs">
          <Field label="Voice">
            <Select value={form.elevenlabsVoiceId} onValueChange={(v) => set("elevenlabsVoiceId", v)}>
              <SelectTrigger className="bg-navy-section border-gold/15 text-silver" data-testid="select-voice"><SelectValue /></SelectTrigger>
              <SelectContent>
                {voiceOptions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name} — {v.desc}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Model">
            <Select value={form.elevenlabsModelId} onValueChange={(v) => set("elevenlabsModelId", v)}>
              <SelectTrigger className="bg-navy-section border-gold/15 text-silver" data-testid="select-model"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="eleven_turbo_v2_5">Turbo v2.5 (Fast, recommended)</SelectItem>
                <SelectItem value="eleven_multilingual_v2">Multilingual v2 (Highest quality)</SelectItem>
                <SelectItem value="eleven_v3">Eleven v3 (Most expressive)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={`Voice Speed — ${(form.voiceSpeed ?? 1).toFixed(2)}x`}>
            <Slider min={0.7} max={1.2} step={0.05} value={[form.voiceSpeed ?? 1]} onValueChange={(v) => set("voiceSpeed", v[0])} data-testid="slider-speed" />
          </Field>
          <Button onClick={() => testVoice.mutate()} disabled={testVoice.isPending} variant="outline" className="border-gold/30 text-gold hover:bg-gold/10" data-testid="button-test-voice">
            <Mic className="h-4 w-4 mr-1.5" /> Test Voice
          </Button>
        </Section>

        {/* Automation */}
        <Section title="Automation">
          <div className="flex items-center justify-between">
            <span className="text-sm text-silver">Auto-recap after each race</span>
            <Switch checked={!!form.autoRecapEnabled} onCheckedChange={(v) => set("autoRecapEnabled", v)} data-testid="switch-autorecap" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-silver">Auto-fetch results from Equibase</span>
            <Switch checked={!!form.autoFetchEnabled} onCheckedChange={(v) => set("autoFetchEnabled", v)} data-testid="switch-autofetch" />
          </div>
          <Field label="Poll Interval (minutes)">
            <Input type="number" min={1} max={30} value={form.fetchPollMinutes ?? 5} onChange={(e) => set("fetchPollMinutes", parseInt(e.target.value) || 5)} className="bg-navy-section border-gold/15 text-silver tabular-nums w-32" data-testid="input-poll" />
          </Field>
        </Section>
      </div>
    </div>
  );
}
