// @vitest-environment jsdom
// PR #33 — ManualIngestModal renders two PDF drop zones + track/date, posts
// multipart FormData to /api/cards/manual-ingest, and routes to /results on
// success.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigate = vi.fn();
vi.mock("wouter", () => ({ useLocation: () => ["/", navigate] }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ManualIngestModal } from "./ManualIngestModal";

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ManualIngestModal />
    </QueryClientProvider>,
  );
}

function pdf(name: string): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: "application/pdf" });
}

beforeEach(() => {
  navigate.mockReset();
});
afterEach(() => cleanup());

describe("ManualIngestModal", () => {
  it("posts multipart FormData and navigates to /results on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        cardId: 7,
        track: "Finger Lakes",
        raceDate: "2026-06-09",
        raceCount: 8,
        conviction: "HIGH",
        source: "manual",
        errors: ["No Equibase PDF dropped — tiered on Brisnet PPs only."],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderModal();
    fireEvent.click(screen.getByTestId("button-manual-ingest"));

    // Submit is disabled until a Brisnet PDF is selected.
    expect((screen.getByTestId("manual-submit") as HTMLButtonElement).disabled).toBe(true);

    const brisInput = screen.getByTestId("manual-brisnet-input") as HTMLInputElement;
    fireEvent.change(brisInput, { target: { files: [pdf("bris.pdf")] } });

    expect((screen.getByTestId("manual-submit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("manual-submit"));

    await waitFor(() => expect(screen.getByTestId("manual-result")).toBeTruthy());
    expect(screen.getByTestId("manual-status-success").textContent).toMatch(/Card #7/);

    // Posted to the right endpoint with multipart FormData.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/cards/manual-ingest");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
    expect((opts.body as FormData).get("track")).toBe("Finger Lakes");
    expect((opts.body as FormData).get("brisnetPdf")).toBeInstanceOf(File);

    // "Enter Results" routes to the scorecard.
    fireEvent.click(screen.getByTestId("manual-go-results"));
    expect(navigate).toHaveBeenCalledWith("/results");
  });

  it("includes the optional Equibase file when one is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        cardId: 9,
        track: "Finger Lakes",
        raceDate: "2026-06-09",
        raceCount: 8,
        source: "manual",
        errors: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderModal();
    fireEvent.click(screen.getByTestId("button-manual-ingest"));
    fireEvent.change(screen.getByTestId("manual-brisnet-input"), {
      target: { files: [pdf("bris.pdf")] },
    });
    fireEvent.change(screen.getByTestId("manual-equibase-input"), {
      target: { files: [pdf("equi.pdf")] },
    });
    fireEvent.click(screen.getByTestId("manual-submit"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("equibasePdf")).toBeInstanceOf(File);
  });
});
