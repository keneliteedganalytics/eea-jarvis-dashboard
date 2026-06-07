import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Settings } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Upload both PP PDFs → server parses/fuses/handicaps → navigate to Review.
export function UploadCard() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: settings } = useQuery<Settings>({ queryKey: ["/api/settings"] });

  const brisRef = useRef<HTMLInputElement>(null);
  const equiRef = useRef<HTMLInputElement>(null);
  const [bris, setBris] = useState<File | null>(null);
  const [equi, setEqui] = useState<File | null>(null);
  const [track, setTrack] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [provider, setProvider] = useState<"anthropic" | "poe">("anthropic");
  const [busy, setBusy] = useState(false);

  const effectiveTrack = track || settings?.defaultTrack || "";

  async function submit() {
    if (!bris || !equi) {
      toast({ title: "Both PDFs required", description: "Attach the Brisnet PPs and the Equibase speed figures.", variant: "destructive" });
      return;
    }
    if (!effectiveTrack || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast({ title: "Track + date required", description: "Enter a track and a YYYY-MM-DD date.", variant: "destructive" });
      return;
    }
    const fd = new FormData();
    fd.append("brisnetPdf", bris);
    fd.append("equibasePdf", equi);
    fd.append("track", effectiveTrack);
    fd.append("date", date);
    fd.append("provider", provider);

    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/upload-pps`, { method: "POST", body: fd });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      const data = (await res.json()) as { cardId: number; racesAnalyzed: number; errors: string[] };
      toast({
        title: `Analyzed ${data.racesAnalyzed} race${data.racesAnalyzed === 1 ? "" : "s"}`,
        description: data.errors.length ? `${data.errors.length} warning(s) — review before publishing.` : "Review & confirm before it goes live.",
      });
      navigate(`/review/${data.cardId}`);
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-gold/25 bg-navy-section/50 p-4" data-testid="upload-pps">
      <div className="flex items-center gap-2 mb-3">
        <Upload className="h-4 w-4 text-gold-dark" />
        <div className="text-xs text-silver font-display font-bold uppercase tracking-[0.14em]">
          Analyze a New Card
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-[10px] uppercase tracking-wide text-muted-brand">
          Brisnet PPs (PDF)
          <Input
            ref={brisRef}
            type="file"
            accept="application/pdf"
            onChange={(e) => setBris(e.target.files?.[0] ?? null)}
            className="mt-1 text-[11px]"
            data-testid="input-brisnet"
          />
        </label>
        <label className="block text-[10px] uppercase tracking-wide text-muted-brand">
          Equibase Speed Figures (PDF)
          <Input
            ref={equiRef}
            type="file"
            accept="application/pdf"
            onChange={(e) => setEqui(e.target.files?.[0] ?? null)}
            className="mt-1 text-[11px]"
            data-testid="input-equibase"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[10px] uppercase tracking-wide text-muted-brand">
            Track
            <Input
              value={track}
              placeholder={settings?.defaultTrack ?? "Track"}
              onChange={(e) => setTrack(e.target.value)}
              className="mt-1 text-[11px]"
              data-testid="input-track"
            />
          </label>
          <label className="block text-[10px] uppercase tracking-wide text-muted-brand">
            Date
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 text-[11px]"
              data-testid="input-date"
            />
          </label>
        </div>
        <label className="block text-[10px] uppercase tracking-wide text-muted-brand">
          LLM Provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as "anthropic" | "poe")}
            className="mt-1 w-full rounded-md border border-gold/20 bg-navy-card px-2 py-1.5 text-[11px] text-silver"
            data-testid="select-provider"
          >
            <option value="anthropic">Anthropic (Claude Sonnet 4.5)</option>
            <option value="poe">Poe</option>
          </select>
        </label>
        <Button
          onClick={submit}
          disabled={busy}
          className="w-full bg-gold hover:bg-gold-light text-navy-bg font-display font-bold tracking-wide"
          data-testid="button-analyze"
        >
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
          {busy ? "Analyzing…" : "Analyze Card"}
        </Button>
      </div>
    </div>
  );
}
