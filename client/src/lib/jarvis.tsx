import { createContext, useContext, useRef, useState, useCallback, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface JarvisTrack {
  src: string;
  label: string;
}

interface JarvisContextValue {
  open: boolean;
  isLoading: boolean;
  isPlaying: boolean;
  label: string;
  currentTime: number;
  duration: number;
  volume: number;
  audioRef: React.RefObject<HTMLAudioElement>;
  play: (track: JarvisTrack) => void;
  briefViaPost: (url: string, label: string) => Promise<void>;
  togglePlay: () => void;
  skip: (seconds: number) => void;
  setVolume: (v: number) => void;
  close: () => void;
}

const JarvisContext = createContext<JarvisContextValue | null>(null);

// API_BASE handling so audio src resolves both locally and when deployed.
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export function JarvisProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [label, setLabel] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const { toast } = useToast();

  const play = useCallback((track: JarvisTrack) => {
    setOpen(true);
    setLabel(track.label);
    const el = audioRef.current;
    if (!el) return;
    const fullSrc = track.src.startsWith("http") ? track.src : `${API_BASE}${track.src}`;
    el.src = fullSrc;
    el.volume = volume;
    el.play().then(() => setIsPlaying(true)).catch(() => {
      // Autoplay may be blocked; surface play button.
      setIsPlaying(false);
    });
  }, [volume]);

  const briefViaPost = useCallback(async (url: string, lbl: string) => {
    setIsLoading(true);
    setOpen(true);
    setLabel(lbl);
    try {
      const res = await apiRequest("POST", url);
      const data = await res.json();
      if (data.audioUrl) {
        play({ src: data.audioUrl, label: lbl });
      } else {
        throw new Error(data.message || "No audio returned");
      }
    } catch (err: any) {
      toast({
        title: "Jarvis unavailable",
        description: err?.message?.slice(0, 160) || "Could not generate audio.",
        variant: "destructive",
      });
      setOpen(false);
    } finally {
      setIsLoading(false);
    }
  }, [play, toast]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, []);

  const skip = useCallback((seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds));
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const close = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setIsPlaying(false);
    setOpen(false);
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onEnd = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnd);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, []);

  return (
    <JarvisContext.Provider
      value={{
        open, isLoading, isPlaying, label, currentTime, duration, volume,
        audioRef, play, briefViaPost, togglePlay, skip, setVolume, close,
      }}
    >
      {children}
      {/* Single persistent audio element */}
      <audio ref={audioRef} hidden />
    </JarvisContext.Provider>
  );
}

export function useJarvis() {
  const ctx = useContext(JarvisContext);
  if (!ctx) throw new Error("useJarvis must be used within JarvisProvider");
  return ctx;
}
