import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { adminPinGate } from "../middleware/admin-pin";

// Default PIN is "5811" (process.env.ADMIN_PIN unset in the test env).
const PIN = "5811";

function mockReq(opts: {
  method: string;
  path?: string;
  header?: string;
  query?: Record<string, unknown>;
}): Request {
  return {
    method: opts.method,
    path: opts.path ?? "/api/cards/9/unlock",
    query: opts.query ?? {},
    header: (name: string) =>
      name.toLowerCase() === "x-admin-pin" ? opts.header : undefined,
  } as unknown as Request;
}

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

describe("adminPinGate", () => {
  let next: NextFunction;
  beforeEach(() => {
    next = vi.fn();
  });

  it("allows GET without a header", () => {
    const res = mockRes();
    adminPinGate(mockReq({ method: "GET", header: undefined }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects POST without a header (401 + code)", () => {
    const res = mockRes();
    adminPinGate(mockReq({ method: "POST", header: undefined }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as { code: string }).code).toBe("ADMIN_PIN_REQUIRED");
  });

  it("rejects POST with a wrong header", () => {
    const res = mockRes();
    adminPinGate(mockReq({ method: "POST", header: "0000" }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts POST with the correct header", () => {
    const res = mockRes();
    adminPinGate(mockReq({ method: "POST", header: PIN }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts POST with the correct ?adminPin query string", () => {
    const res = mockRes();
    adminPinGate(
      mockReq({ method: "POST", query: { adminPin: PIN } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows mutating requests on the internal allow-list", () => {
    const res = mockRes();
    adminPinGate(
      mockReq({ method: "POST", path: "/api/internal/cron-callback" }),
      res,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
