// @vitest-environment jsdom
// PR #27 Part B4 (frontend) — PullCardModal renders a structured per-source
// error UI: clean per-source status rows + a credentials hint when both sources
// fail with a login-style error, plus a Copy-diagnostics affordance.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PullCardModal } from "./PullCardModal";

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PullCardModal />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

beforeEach(() => {
  apiRequest.mockReset();
});
afterEach(() => cleanup());

describe("PullCardModal structured error UI", () => {
  it("shows per-source failure lines + a credentials hint when both sources fail to log in", async () => {
    apiRequest.mockResolvedValue(
      jsonResponse({
        status: "failed",
        track: "Finger Lakes",
        date: "2026-06-09",
        warnings: ["Equibase failed", "Brisnet failed"],
        sources: {
          equibase: { ok: false, error: "Equibase login blocked by bot protection (Incapsula)" },
          brisnet: { ok: false, error: "Brisnet login endpoint no longer accepts POST (HTTP 405)" },
        },
      }),
    );

    renderModal();
    fireEvent.click(screen.getByTestId("button-pull-card"));
    fireEvent.click(screen.getByTestId("pull-submit"));

    await waitFor(() => expect(screen.getByTestId("pull-result")).toBeTruthy());
    expect(screen.getByTestId("pull-status-failed")).toBeTruthy();
    // Both rows present with humanized text (not the raw stack).
    expect(screen.getByTestId("source-row-equibase").textContent).toMatch(/bot protection/i);
    expect(screen.getByTestId("source-row-brisnet").textContent).toMatch(/moved/i);
    // The "login expired — check credentials" hint fires when both fail on login.
    expect(screen.getByTestId("pull-creds-hint").textContent).toMatch(/credentials/i);
    expect(screen.getByTestId("copy-diagnostics")).toBeTruthy();
  });

  it("renders a partial-success card when Equibase succeeds and Brisnet fails", async () => {
    apiRequest.mockResolvedValue(
      jsonResponse({
        status: "partial",
        cardId: 42,
        track: "Finger Lakes",
        date: "2026-06-09",
        raceCount: 8,
        conviction: "B",
        warnings: ["Brisnet failed; persisted Equibase-only partial draft."],
        sources: {
          equibase: { ok: true, raceCount: 8 },
          brisnet: { ok: false, error: "download HTTP 405 for FL" },
        },
      }),
    );

    renderModal();
    fireEvent.click(screen.getByTestId("button-pull-card"));
    fireEvent.click(screen.getByTestId("pull-submit"));

    await waitFor(() => expect(screen.getByTestId("pull-status-partial")).toBeTruthy());
    expect(screen.getByTestId("pull-status-partial").textContent).toMatch(/Card #42/);
    expect(screen.getByTestId("source-row-equibase").textContent).toMatch(/8 races/);
    // Only one source failed, so the both-failed credentials hint must NOT show.
    expect(screen.queryByTestId("pull-creds-hint")).toBeNull();
  });
});
