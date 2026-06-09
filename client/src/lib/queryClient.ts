import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// PR #43: admin PIN gate. Every mutating request carries the PIN saved in this
// browser; a 401 with code ADMIN_PIN_REQUIRED clears the stale PIN, re-prompts,
// and retries once.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ADMIN_PIN_KEY = "eea_admin_pin";

function getAdminPin(): string | null {
  return localStorage.getItem(ADMIN_PIN_KEY);
}

function promptForPin(): string | null {
  const pin = window.prompt("Admin PIN required to make changes:");
  if (pin) localStorage.setItem(ADMIN_PIN_KEY, pin);
  return pin;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = data
    ? { "Content-Type": "application/json" }
    : {};
  const body = data ? JSON.stringify(data) : undefined;

  if (MUTATING.has(method.toUpperCase())) {
    let pin = getAdminPin();
    if (!pin) pin = promptForPin();
    if (pin) headers["x-admin-pin"] = pin;
  }

  let res = await fetch(`${API_BASE}${url}`, { method, headers, body });

  if (res.status === 401) {
    const errBody = await res.clone().json().catch(() => null);
    if (errBody?.code === "ADMIN_PIN_REQUIRED") {
      localStorage.removeItem(ADMIN_PIN_KEY);
      const pin = promptForPin();
      if (pin) {
        headers["x-admin-pin"] = pin;
        res = await fetch(`${API_BASE}${url}`, { method, headers, body });
      }
    }
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
