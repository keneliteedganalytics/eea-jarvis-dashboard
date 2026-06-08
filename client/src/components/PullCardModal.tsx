import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
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
import { Download, CheckCircle2, XCircle, AlertTriangle, Copy } from "lucide-react";

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

interface SourceResult {
  ok: boolean;
  raceCount?: number;
  error?: string;
}

interface OnDemandResult {
  status: "success" | "partial" | "failed";
  cardId?: number;
  track: string;
  date: string;
  raceCount?: number;
  conviction?: string;
  sources: { equibase: SourceResult; brisnet: SourceResult };
  warnings: string[];
}

// One human-readable line per source. Collapse the known bot-wall / endpoint
// signatures to a short phrase; otherwise show the raw error verbatim.
function humanizeSourceError(raw: string | undefined): string {
  if (!raw) return "Unknown error.";
  const e = raw.toLowerCase();
  if (e.includes("incapsula") || e.includes("bot protection") || e.includes("nocookies")) {
    return "Blocked by bot protection (login can't be automated).";
  }
  if (e.includes("405") || e.includes("no longer accepts post") || e.includes("object storage")) {
    return "Login endpoint moved — automated login unavailable.";
  }
  if (e.includes("did not set a session cookie") || e.includes("login")) {
    return "Login failed — check credentials in Settings.";
  }
  if (e.includes("not listed for date")) return "No card listed for this date.";
  if (e.includes("timed out")) return "Timed out reaching the source.";
  return raw;
}

// Both sources failing with a login-style error → almost always creds/session.
function bothLoginFailed(r: OnDemandResult): boolean {
  const looksLikeLogin = (s: SourceResult) =>
    !s.ok &&
    /login|cookie|incapsula|bot protection|405|object storage|credential/i.test(s.error ?? "");
  return looksLikeLogin(r.sources.equibase) && looksLikeLogin(r.sources.brisnet);
}

function SourceRow({ name, src }: { name: string; src: SourceResult }) {
  return (
    <div className="flex items-start gap-2 text-sm" data-testid={`source-row-${name.toLowerCase()}`}>
      {src.ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <span className="font-medium tabular-nums">{name}</span>{" "}
        {src.ok ? (
          <span className="text-muted-foreground">
            {src.raceCount ?? 0} races
          </span>
        ) : (
          <span className="text-muted-foreground">{humanizeSourceError(src.error)}</span>
        )}
      </div>
    </div>
  );
}

export function PullCardModal() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState(TRACKS[0]);
  const [date, setDate] = useState(todayIso());
  const [result, setResult] = useState<OnDemandResult | null>(null);

  const pullMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/cards/on-demand-ingest", { track, date });
      return res.json() as Promise<OnDemandResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/cards/drafts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      if (data.status === "success") {
        toast({
          title: `Draft card #${data.cardId} ready`,
          description: `${data.raceCount ?? 0} races · conviction ${data.conviction ?? "—"}.`,
        });
      }
    },
    onError: (e) => {
      toast({ title: "Pull failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  const copyDiagnostics = () => {
    if (!result) return;
    const lines = [
      `Pull Card diagnostics`,
      `track=${result.track} date=${result.date} status=${result.status}`,
      `equibase: ok=${result.sources.equibase.ok}` +
        (result.sources.equibase.error ? ` error=${result.sources.equibase.error}` : "") +
        (result.sources.equibase.raceCount != null ? ` races=${result.sources.equibase.raceCount}` : ""),
      `brisnet: ok=${result.sources.brisnet.ok}` +
        (result.sources.brisnet.error ? ` error=${result.sources.brisnet.error}` : "") +
        (result.sources.brisnet.raceCount != null ? ` races=${result.sources.brisnet.raceCount}` : ""),
      ...(result.warnings.length ? [`warnings:`, ...result.warnings.map((w) => `  - ${w}`)] : []),
    ];
    navigator.clipboard?.writeText(lines.join("\n"));
    toast({ title: "Diagnostics copied" });
  };

  const reset = () => {
    setResult(null);
    setOpen(false);
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
          data-testid="button-pull-card"
        >
          <Download className="h-4 w-4 mr-1.5 shrink-0" /> Pull Card
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pull a card</DialogTitle>
          <DialogDescription>
            Fetch Equibase + Brisnet for a track and date, handicap it, and land a draft for review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pull-track">Track</Label>
            <Select value={track} onValueChange={setTrack}>
              <SelectTrigger id="pull-track" data-testid="pull-track-select">
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
            <Label htmlFor="pull-date">Date</Label>
            <Input
              id="pull-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="pull-date-input"
            />
          </div>

          {result && (
            <div
              className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-2"
              data-testid="pull-result"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-display font-semibold tabular-nums">
                  {result.status === "success" && (
                    <span className="text-emerald-500" data-testid="pull-status-success">
                      Card #{result.cardId} created — {result.raceCount ?? 0} races
                    </span>
                  )}
                  {result.status === "partial" && (
                    <span className="text-amber-500" data-testid="pull-status-partial">
                      Partial success — Card #{result.cardId} created
                    </span>
                  )}
                  {result.status === "failed" && (
                    <span className="text-red-500" data-testid="pull-status-failed">
                      Pull failed
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={copyDiagnostics}
                  data-testid="copy-diagnostics"
                >
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy diagnostics
                </Button>
              </div>

              <div className="space-y-1">
                <SourceRow name="Equibase" src={result.sources.equibase} />
                <SourceRow name="Brisnet" src={result.sources.brisnet} />
              </div>

              {bothLoginFailed(result) && (
                <div
                  className="flex items-start gap-2 text-sm text-red-500"
                  data-testid="pull-creds-hint"
                >
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Login expired. Check credentials in Settings.</span>
                </div>
              )}

              {result.status === "partial" && result.cardId != null && (
                <p className="text-xs text-muted-foreground">
                  A draft was saved. Review it, then Lock to keep or Discard.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          {result && result.status !== "failed" ? (
            <Button
              onClick={reset}
              className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
              data-testid="pull-done"
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pullMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => pullMutation.mutate()}
                disabled={pullMutation.isPending}
                className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
                data-testid="pull-submit"
              >
                {pullMutation.isPending ? "Pulling…" : result ? "Retry" : "Pull"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
