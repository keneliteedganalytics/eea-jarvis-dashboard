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
import { Download } from "lucide-react";

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

interface OnDemandResult {
  status: "success" | "partial" | "failed";
  cardId?: number;
  raceCount?: number;
  conviction?: string;
  warnings: string[];
}

export function PullCardModal() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState(TRACKS[0]);
  const [date, setDate] = useState(todayIso());

  const pullMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/cards/on-demand-ingest", { track, date });
      return res.json() as Promise<OnDemandResult>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cards/drafts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cards"] });
      if (data.status === "failed") {
        toast({
          title: "Pull failed",
          description: data.warnings[0] ?? "No card produced.",
          variant: "destructive",
        });
        return;
      }
      const partial = data.status === "partial" ? " (Equibase only — Brisnet failed)" : "";
      toast({
        title: `Draft card #${data.cardId} ready${partial}`,
        description: `${data.raceCount ?? 0} races · conviction ${data.conviction ?? "—"}. Review then lock.`,
      });
      setOpen(false);
    },
    onError: (e) => {
      toast({ title: "Pull failed", description: (e as Error).message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pullMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => pullMutation.mutate()}
            disabled={pullMutation.isPending}
            className="bg-gold hover:bg-gold-light text-navy-bg font-display font-bold"
            data-testid="pull-submit"
          >
            {pullMutation.isPending ? "Pulling…" : "Pull"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
