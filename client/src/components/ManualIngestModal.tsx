import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileUp, CheckCircle2 } from "lucide-react";

// Mirrors the canonical track list in server/services/on-demand-ingest.ts.
const TRACKS = [
  "Finger Lakes",
  "Saratoga",
  "Belmont",
  "Churchill",
  "Gulfstream",
  "Tampa Bay Downs",
  "Oaklawn",
  "Aqueduct",
  "Keeneland",
  "Del Mar",
  "Santa Anita",
  "Pimlico",
  "Monmouth",
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ManualResult {
  ok: boolean;
  cardId?: number;
  track: string;
  raceDate: string;
  raceCount?: number;
  conviction?: string;
  source: "manual";
  errors: string[];
}

export function ManualIngestModal() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState(TRACKS[0]);
  const [date, setDate] = useState(todayIso());
  const [brisnetFile, setBrisnetFile] = useState<File | null>(null);
  const [equibaseFile, setEquibaseFile] = useState<File | null>(null);
  const [result, setResult] = useState<ManualResult | null>(null);
  const brisnetRef = useRef<HTMLInputElement>(null);
  const equibaseRef = useRef<HTMLInputElement>(null);

  const ingestMutation = useMutation({
    mutationFn: async () => {
      if (!brisnetFile) throw new Error("Drop the Brisnet Ultimate PPs PDF first.");
      const form = new FormData();
      form.append("track", track);
      form.append("raceDate", date);
      form.append("brisnetPdf", brisnetFile);
      if (equibaseFile) form.append("equibasePdf", equibaseFile);
      const res = await fetch("/api/cards/manual-ingest", { method: "POST", body: form });
      const body = (await res.json()) as ManualResult | { error: string };
      if (!res.ok) throw new Error(("error" in body && body.error) || "Ingest failed");
      return body as ManualResult;
    },
    onSuccess: async (data) => {
      setResult(data);
      // The dashboard renders the new draft via /api/cards/drafts (DraftCardsSection)
      // and the active-card via /api/cards/latest. Force a refetch of every card-
      // and race-list key so the card appears immediately with no page reload.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/cards/drafts"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["/api/cards"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["/api/cards/latest"], refetchType: "all" }),
        queryClient.invalidateQueries({ queryKey: ["/api/cards/archived"], refetchType: "all" }),
      ]);
      toast({
        title: `Card #${data.cardId} ingested`,
        description: `${data.raceCount ?? 0} races · conviction ${data.conviction ?? "—"}.`,
      });
    },
    onError: (e) => {
      toast({ title: "Ingest failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  const reset = () => {
    setResult(null);
    setBrisnetFile(null);
    setEquibaseFile(null);
    if (brisnetRef.current) brisnetRef.current.value = "";
    if (equibaseRef.current) equibaseRef.current.value = "";
    setOpen(false);
  };

  const goToResults = () => {
    const cardId = result?.cardId;
    reset();
    navigate(cardId ? `/results?cardId=${cardId}` : "/results");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="border-gold/30 text-gold hover:bg-gold/10"
          data-testid="button-manual-ingest"
        >
          <FileUp className="h-4 w-4 mr-1.5 shrink-0" /> Manual Ingest (PDF)
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manual card ingest</DialogTitle>
          <DialogDescription>
            Drop the Brisnet Ultimate PPs PDF (and optionally the Equibase Pocket PPs PDF) for a
            track and date. Jarvis parses, fuses, and tiers it as a draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="manual-track">Track</Label>
            <Select value={track} onValueChange={setTrack}>
              <SelectTrigger id="manual-track" data-testid="manual-track-select">
                <SelectValue placeholder="Select track" />
              </SelectTrigger>
              <SelectContent>
                {TRACKS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-date">Date</Label>
            <Input
              id="manual-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="manual-date-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-brisnet">Brisnet Ultimate PPs (required)</Label>
            <Input
              id="manual-brisnet"
              ref={brisnetRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setBrisnetFile(e.target.files?.[0] ?? null)}
              data-testid="manual-brisnet-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-equibase">Equibase Pocket PPs (optional)</Label>
            <Input
              id="manual-equibase"
              ref={equibaseRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setEquibaseFile(e.target.files?.[0] ?? null)}
              data-testid="manual-equibase-input"
            />
          </div>

          {result && (
            <div
              className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2"
              data-testid="manual-result"
            >
              <div className="flex items-center gap-2 text-sm font-display font-semibold tabular-nums">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="text-emerald-500" data-testid="manual-status-success">
                  Card #{result.cardId} created — {result.raceCount ?? 0} races
                </span>
              </div>
              {result.errors.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {result.errors.map((e, i) => (
                    <li key={i} data-testid={`manual-note-${i}`}>
                      {e}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          {result ? (
            <Button
              onClick={goToResults}
              className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
              data-testid="manual-go-results"
            >
              Enter Results
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={ingestMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => ingestMutation.mutate()}
                disabled={ingestMutation.isPending || !brisnetFile}
                className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
                data-testid="manual-submit"
              >
                {ingestMutation.isPending ? "Ingesting…" : "Ingest"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
