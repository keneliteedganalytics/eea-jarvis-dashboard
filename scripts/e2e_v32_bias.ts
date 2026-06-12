// v3.2 track-bias E2E sanity check.
//
// Hits the production bias-state endpoint for card 31 (a completed card with
// all 7 races graded) and asserts the response is well-formed. Read-only — it
// only GETs; it never POSTs a result. Run with:
//
//   npx tsx scripts/e2e_v32_bias.ts
//
// Exit code is 0 only if the response is present and well-formed.
//
// NOTE: the live endpoint returns the detector's camelCase BiasState shape
// (hotPps, deadPps, styleBias, nGraded, confidence, active), not the snake_case
// shape sketched in some early notes. We assert against the real shape.

const BASE = "https://jarvis.elite-edge-analytics.com";
const CARD_ID = 31;
const BASIC_AUTH = "EliteEdgeAnalytics:Austin08";
const ADMIN_PIN = "5811";

async function main(): Promise<void> {
  const url = `${BASE}/api/cards/${CARD_ID}/bias-state`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(BASIC_AUTH).toString("base64")}`,
      "x-admin-pin": ADMIN_PIN,
    },
  });

  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }

  // When the route isn't deployed, the SPA catch-all serves index.html with a
  // 200. Detect that explicitly so we emit a clear "not deployed" message
  // instead of a cryptic JSON parse error — v3.2 is in-dev and the bias-state
  // route ships with this branch, so prod legitimately won't have it until merge.
  const raw = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") || raw.trimStart().startsWith("<")) {
    throw new Error(
      `GET ${url} returned non-JSON (content-type: ${contentType || "none"}). ` +
        `The bias-state route is likely not deployed yet — v3.2 is in-dev on ` +
        `feat/v3.2-track-bias and ships with this branch.`,
    );
  }

  const body = JSON.parse(raw) as Record<string, unknown>;
  console.log("[e2e:v3.2] bias-state response:", JSON.stringify(body, null, 2));

  const errors: string[] = [];

  if (!Array.isArray(body.hotPps)) errors.push("hotPps is not an array");
  if (!Array.isArray(body.deadPps)) errors.push("deadPps is not an array");

  const confidence = body.confidence;
  if (typeof confidence !== "number") {
    errors.push("confidence is not a number");
  } else if (confidence < 0 || confidence > 0.85) {
    errors.push(`confidence ${confidence} out of range [0, 0.85]`);
  }

  const nGraded = body.nGraded;
  if (typeof nGraded !== "number" || !Number.isInteger(nGraded) || nGraded < 0) {
    errors.push(`nGraded is not a non-negative integer (got ${String(nGraded)})`);
  }

  if (typeof body.active !== "boolean") errors.push("active is not a boolean");

  if (errors.length > 0) {
    throw new Error(`Malformed bias-state response:\n - ${errors.join("\n - ")}`);
  }

  console.log(
    `[e2e:v3.2] OK — card ${CARD_ID}: nGraded=${nGraded}, ` +
      `hotPps=[${(body.hotPps as unknown[]).join(", ")}], ` +
      `deadPps=[${(body.deadPps as unknown[]).join(", ")}], ` +
      `styleBias=${String(body.styleBias)}, ` +
      `confidence=${confidence}, active=${String(body.active)}`,
  );
}

main().catch((err) => {
  console.error("[e2e:v3.2] FAILED:", (err as Error).message);
  process.exit(1);
});
