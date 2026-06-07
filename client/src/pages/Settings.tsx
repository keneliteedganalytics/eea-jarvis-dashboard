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
import { Mic, Save } from "lucide-react";

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

export default function Settings() {
  const { data: settings, isLoading } = useQuery<SettingsType>({ queryKey: ["/api/settings"] });
  const { data: liveVoices } = useQuery<LiveVoice[]>({ queryKey: ["/api/voices"], retry: false });
  const { toast } = useToast();
  const jarvis = useJarvis();
  const [form, setForm] = useState<Partial<SettingsType>>({});

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", "/api/settings", form);
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
