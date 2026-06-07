import { useVoiceJarvis } from "@/lib/voice/useVoiceJarvis";
import { TierPill } from "@/components/brand/TierPill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Mic,
  MicOff,
  Loader2,
  X,
  Radio,
  ArrowRight,
  Check,
  Undo2,
} from "lucide-react";
import type { VoiceStatus } from "@/lib/voice/types";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "Standby",
  listening: "Listening",
  recording: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function StatusDot({ status }: { status: VoiceStatus }) {
  const active = status === "recording" || status === "listening";
  const busy = status === "transcribing" || status === "thinking";
  return (
    <span className="relative flex h-2 w-2">
      {active && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2 w-2 rounded-full",
          active ? "bg-gold" : busy ? "bg-gold-light" : "bg-muted-brand/50",
        )}
      />
    </span>
  );
}

export function VoiceDock() {
  const v = useVoiceJarvis();
  if (!v.supported) return null;

  return (
    <>
      {v.enabled && v.panelOpen && <ConversationPanel />}
      <ControlBar />
    </>
  );
}

function ControlBar() {
  const v = useVoiceJarvis();
  const recording = v.status === "recording";

  return (
    <div
      data-testid="voice-dock"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-gold/30 bg-navy-raised/95 px-2.5 py-2 shadow-2xl backdrop-blur"
      style={{ boxShadow: "0 0 0 1px hsl(44 70% 47% / 0.12), 0 24px 48px -10px hsl(214 78% 1% / 0.8)" }}
    >
      {/* Master toggle */}
      <Button
        size="icon"
        variant="ghost"
        className={cn(
          "h-9 w-9",
          v.enabled ? "text-gold hover:text-gold-light" : "text-muted-brand hover:text-silver",
        )}
        onClick={v.toggleEnabled}
        data-testid="button-voice-enable"
        title={v.enabled ? "Turn voice off" : "Turn voice on"}
      >
        {v.enabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </Button>

      {v.enabled && (
        <>
          <div className="flex items-center gap-2 px-1">
            <StatusDot status={v.status} />
            <span className="text-xs text-silver tabular-nums min-w-[5.5rem]">
              {v.status === "thinking" || v.status === "transcribing" ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {STATUS_LABEL[v.status]}
                </span>
              ) : (
                STATUS_LABEL[v.status]
              )}
            </span>
          </div>

          {/* Push-to-talk */}
          <Button
            size="sm"
            className={cn(
              "h-9 rounded-md font-display font-bold uppercase tracking-wider text-[11px]",
              recording
                ? "bg-gold-light text-navy-bg"
                : "bg-gold/15 text-gold border border-gold/30 hover:bg-gold/25",
            )}
            onMouseDown={v.startPushToTalk}
            onMouseUp={v.stopPushToTalk}
            onMouseLeave={() => recording && v.stopPushToTalk()}
            onTouchStart={(e) => {
              e.preventDefault();
              v.startPushToTalk();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              v.stopPushToTalk();
            }}
            data-testid="button-voice-ptt"
            title="Hold to talk (or hold Space)"
          >
            {recording ? "Release" : "Hold / Space"}
          </Button>

          {/* Wake-word toggle */}
          <Button
            size="icon"
            variant="ghost"
            className={cn(
              "h-9 w-9",
              v.wakeEnabled ? "text-gold" : "text-muted-brand hover:text-silver",
            )}
            onClick={v.toggleWake}
            data-testid="button-voice-wake"
            title={v.wakeEnabled ? "Disable “Hey Jarvis”" : "Enable “Hey Jarvis”"}
          >
            <Radio className="h-4 w-4" />
          </Button>

          {/* Panel toggle */}
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 text-muted-brand hover:text-silver"
            onClick={() => v.setPanelOpen(!v.panelOpen)}
            data-testid="button-voice-panel"
            title="Conversation"
          >
            {v.panelOpen ? <X className="h-4 w-4" /> : <Radio className="h-4 w-4 opacity-0" />}
            {!v.panelOpen && <span className="text-[10px] font-bold">{v.exchanges.length || ""}</span>}
          </Button>
        </>
      )}
    </div>
  );
}

function ConversationPanel() {
  const v = useVoiceJarvis();

  return (
    <div
      data-testid="voice-panel"
      className="fixed bottom-[4.5rem] left-4 z-50 flex max-h-[60vh] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-gold/30 bg-navy-raised/95 shadow-2xl backdrop-blur"
      style={{ boxShadow: "0 0 0 1px hsl(44 70% 47% / 0.12), 0 24px 48px -10px hsl(214 78% 1% / 0.8)" }}
    >
      <div className="flex items-center justify-between border-b border-gold/10 px-4 py-3">
        <div className="text-[10px] font-display font-bold uppercase tracking-[0.2em] text-gold-dark">
          Jarvis · Trackside
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-muted-brand hover:text-silver"
          onClick={() => v.setPanelOpen(false)}
          data-testid="button-voice-panel-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {v.exchanges.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-brand">
            Hold the button (or Space) and call the trip. Try “Hey Jarvis, the four
            just got bumped at the break.”
          </div>
        ) : (
          v.exchanges.map((x) => (
            <div key={x.id} className="space-y-1.5">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-white/[0.04] px-3 py-1.5 text-xs text-silver">
                  {x.userTranscript}
                </div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-lg rounded-tl-sm border border-gold/15 bg-gold/[0.06] px-3 py-1.5 text-xs text-silver">
                  {x.jarvisResponse}
                </div>
              </div>

              {x.proposedChanges && x.proposedChanges.length > 0 && (
                <div className="ml-2 space-y-1.5 rounded-md border border-gold/15 bg-navy-section/60 p-2">
                  {x.proposedChanges.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <span className="text-muted-brand">
                        R{/* race number unknown client-side */}
                        {c.horsePgm ? ` #${c.horsePgm}` : ""}
                        {c.horseName ? ` ${c.horseName}` : ""}
                      </span>
                      <TierPill tier={c.oldTier} size="sm" />
                      <ArrowRight className="h-3 w-3 text-muted-brand" />
                      <TierPill tier={c.newTier} size="sm" />
                    </div>
                  ))}

                  {x.status === "pending" && (
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        className="h-7 flex-1 bg-gold text-navy-bg hover:bg-gold-light text-[11px] font-bold"
                        onClick={v.confirmPending}
                        data-testid="button-voice-confirm"
                      >
                        <Check className="mr-1 h-3 w-3" /> Apply
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 flex-1 border border-slate-brand/30 text-muted-brand hover:text-silver text-[11px]"
                        onClick={v.discardPending}
                        data-testid="button-voice-discard"
                      >
                        Discard
                      </Button>
                    </div>
                  )}
                  {x.status === "applied" && (
                    <div className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-win">
                      Applied
                    </div>
                  )}
                  {x.status === "discarded" && (
                    <div className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-brand">
                      Discarded
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-gold/10 px-4 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full text-[11px] text-muted-brand hover:text-silver"
          onClick={v.undoLast}
          data-testid="button-voice-undo"
        >
          <Undo2 className="mr-1.5 h-3 w-3" /> Undo last change
        </Button>
      </div>
    </div>
  );
}
