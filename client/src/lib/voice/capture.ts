// Mic capture via MediaRecorder. Records to webm/opus (falls back to whatever
// the browser supports — iOS Safari uses mp4/aac) and returns a single Blob on
// stop. The stream is acquired lazily and reused across recordings so the
// browser only prompts for mic permission once.

let sharedStream: MediaStream | null = null;

async function getStream(): Promise<MediaStream> {
  if (sharedStream && sharedStream.active) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return sharedStream;
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "";
}

export interface Recorder {
  stop: () => Promise<{ blob: Blob; mimeType: string }>;
  cancel: () => void;
}

// Start recording. Returns a handle; call stop() to finalize and get the blob.
export async function startRecording(): Promise<Recorder> {
  const stream = await getStream();
  const mimeType = pickMimeType();
  const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.start();

  return {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          const type = rec.mimeType || mimeType || "audio/webm";
          resolve({ blob: new Blob(chunks, { type }), mimeType: type });
        };
        rec.stop();
      }),
    cancel: () => {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}

// Release the shared mic stream (e.g. when the user turns voice fully off).
export function releaseMic(): void {
  if (sharedStream) {
    sharedStream.getTracks().forEach((t) => t.stop());
    sharedStream = null;
  }
}

export function micSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}
