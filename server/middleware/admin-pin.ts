import type { Request, Response, NextFunction } from "express";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Default to "5811" so the gate works even if ADMIN_PIN is unset on first deploy.
const PIN = process.env.ADMIN_PIN || "5811";

// Paths that are mutating but MUST stay open (e.g. health probes, websocket
// handshakes, internal cron callbacks). Add to this allow-list cautiously.
const ALLOW_LIST: RegExp[] = [
  /^\/api\/internal\//, // reserved for future internal callers
];

export function adminPinGate(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (ALLOW_LIST.some((re) => re.test(req.path))) return next();

  const supplied = req.header("x-admin-pin") ?? req.query.adminPin;
  if (supplied !== PIN) {
    return res
      .status(401)
      .json({ error: "Admin PIN required", code: "ADMIN_PIN_REQUIRED" });
  }
  next();
}
