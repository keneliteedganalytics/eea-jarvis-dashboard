import type { Response } from "express";

// Central SSE client registry + broadcaster. Kept separate from routes.ts so
// the poller can broadcast without a circular import.
const sseClients = new Set<Response>();

export function addSseClient(res: Response) {
  sseClients.add(res);
}

export function removeSseClient(res: Response) {
  sseClients.delete(res);
}

export function broadcastEvent(type: string, data: Record<string, unknown> = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of Array.from(sseClients)) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}
