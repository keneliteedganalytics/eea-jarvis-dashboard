import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { storage } from "./storage";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const app = express();
const httpServer = createServer(app);

// ── Trust proxy (Railway / any reverse proxy) ─────────────────────────────
// Required for correct req.ip + secure-cookie handling behind Railway's edge.
app.set("trust proxy", 1);

// ── Healthcheck (must be before auth so Railway can probe it) ─────────────
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

// ── Optional HTTP Basic Auth ──────────────────────────────────────────────
// Enabled when BOTH BASIC_AUTH_USER and BASIC_AUTH_PASS are set in the env.
// When unset (local dev), the site is open. Auth is enforced on EVERY route
// except /healthz so Railway's edge probe stays unauthenticated.
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
// Public, unauthenticated paths. Kept deliberately tiny: the marketing
// track-record page, its aggregate-only API, and the OG share image. Matched
// by EXACT path so data routes like /api/cards are never whitelisted.
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/track-record",
  "/api/public/track-record",
  "/og-track-record.svg", // OG share image — social crawlers fetch it unauthenticated
  "/favicon.png",
]);
// The public page is a client-rendered SPA, so its static bundle (the hashed
// JS/CSS Vite emits under /assets) must load unauthenticated or the page stays
// blank for the public. The bundle is just application code — it carries NO
// secrets and NO data; everything sensitive stays behind the auth-gated /api/*
// routes (only /api/public/track-record is open, and it is aggregate-only).
// This is the single prefix exception; everything else remains exact-match.
function isPublicPath(p: string): boolean {
  return PUBLIC_PATHS.has(p) || p.startsWith("/assets/");
}
if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  const expectedUser = Buffer.from(BASIC_AUTH_USER);
  const expectedPass = Buffer.from(BASIC_AUTH_PASS);
  app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next();
    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) {
      res.set("WWW-Authenticate", 'Basic realm="EEA Jarvis", charset="UTF-8"');
      return res.status(401).send("Authentication required");
    }
    let user = "", pass = "";
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    } catch {
      // fall through to 401
    }
    const userBuf = Buffer.from(user);
    const passBuf = Buffer.from(pass);
    const userOk =
      userBuf.length === expectedUser.length &&
      timingSafeEqual(userBuf, expectedUser);
    const passOk =
      passBuf.length === expectedPass.length &&
      timingSafeEqual(passBuf, expectedPass);
    if (userOk && passOk) return next();
    res.set("WWW-Authenticate", 'Basic realm="EEA Jarvis", charset="UTF-8"');
    return res.status(401).send("Authentication required");
  });
  console.log("[auth] HTTP basic auth ENABLED for user:", BASIC_AUTH_USER);
} else {
  console.log("[auth] HTTP basic auth DISABLED (BASIC_AUTH_USER/PASS not set)");
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // PR #22: seed Jarvis/Scarlett voice ids from env if provided (idempotent).
  storage.seedVoiceSettings();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // On Railway/containers we must bind 0.0.0.0 so the edge proxy can reach us.
  // In production we always bind 0.0.0.0 unless HOST is explicitly set.
  const defaultHost =
    process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  // reusePort is Linux-only; on macOS it throws ENOTSUP.
  const listenOpts: { port: number; host: string; reusePort?: boolean } = {
    port,
    host: process.env.HOST || defaultHost,
  };
  if (process.platform === "linux") {
    listenOpts.reusePort = true;
  }
  httpServer.listen(listenOpts, () => {
    log(`serving on port ${port}`);
  });
})();
