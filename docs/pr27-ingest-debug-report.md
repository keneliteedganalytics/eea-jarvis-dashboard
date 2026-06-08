# PR #27 — Part B1 Ingest Auth Debug Dump (live, 2026-06-08)

Live probe of the Equibase + Brisnet login/download chains with a real Chrome UA
and tight per-fetch timeouts. **No credential bypass attempted** — this documents
the empirical state so the fix surfaces a clean, honest error rather than faking
success.

Credentials exercised: `Ken6741` (both sites). Same creds, same result regardless
of validity (see Equibase note) — proving the blocker is upstream infrastructure,
not the password.

## Equibase — Imperva bot-wall + CMP consent gate, plus wrong endpoint in code

| Hop | Request | Status | Set-Cookie | Notes |
|-----|---------|--------|-----------|-------|
| GET form | `eebCustomerLogon.cfm` | 200 HTML | `COOKIE_TEST`, `visid_incap_2434933`, `nlbi_2434933`, `incap_ses_1844_2434933` | Imperva/Incapsula challenge stub `<script src="/inan-giues-thing-...">` + UniConsent CMP. No `CFID`/`CFTOKEN`. |
| POST (current code) | `username`/`password` → `eebCustomerLogon.cfm` | 200 HTML | `COOKIE_TEST`, `visid_incap`, `incap_ses` | **Current code posts to the form-DISPLAY page with the wrong field names.** It just re-renders the login HTML — never authenticates. This is why the jar never gets `CFID`/`CFTOKEN`. |
| POST (corrected) | `user_id`/`customer_password`/`continue_button` → `eebCustomerLogonAction.cfm` | **302 → `eebErrorNoCookies.cfm`** | `visid_incap`, `incap_ses` | Correct CF action endpoint + field names confirmed — the app now actually responds. It redirects to **"No Cookies"** because the Incapsula `COOKIE_TEST` round-trip / JS challenge hasn't been satisfied by a plain fetch client. |

**Root cause (Equibase):** two layers.
1. **Code bug (fixable):** wrong action URL (`eebCustomerLogon.cfm` instead of
   `eebCustomerLogonAction.cfm`), wrong field names (`username`/`password`
   instead of `user_id`/`customer_password`/`continue_button`), and the env var
   drift (`EQUIBASE_USERNAME` vs the documented `EQUIBASE_USER`). All corrected.
2. **Upstream bot-wall (NOT bypassable from a server fetch):** equibase.com now
   fronts the premium login with Imperva/Incapsula + a UniConsent CMP. A plain
   Node fetch cannot execute the JS challenge, so the `COOKIE_TEST` handshake
   fails and CF returns `eebErrorNoCookies.cfm`. This requires a real browser
   (or a paid scraping/anti-bot service). **We do not fake past it** — we detect
   it and surface a clean error.

## Brisnet — login + download endpoints migrated to Akamai object storage (GET-only)

| Request | Status | Allow | Set-Cookie | Notes |
|---------|--------|-------|-----------|-------|
| GET `/product/login` | (timeout/slow) | — | — | Object-store GET hangs from this host. |
| POST `/product/login` | **405** | **`GET, HEAD, OPTIONS`** | `ak_bmsc` | Body: `405 Method Not Allowed … ResourceType: OBJECT … HostId: …Akamai…`. The old POST login form is **gone** — the path is now a static Akamai object. |
| POST `/product/download/.../FL/D/0/` | **405** | **`GET, HEAD, OPTIONS`** | `ak_bmsc` | Same Akamai 405. Download is GET-only now. |

**Root cause (Brisnet):** the entire `brisnet.com/product/*` surface is now served
from an **Akamai object store** (`ResourceType: OBJECT`, `ak_bmsc` cookie, Akamai
`HostId`). The POST-based PHP/Symfony login the code assumed **no longer exists**;
POST returns `405` with `Allow: GET, HEAD, OPTIONS`. The download object is also
GET-only and sits behind the Akamai bot manager (`ak_bmsc`), so an unauthenticated
GET does not yield a zip.

## What we ship (per spec: do NOT fake success)

- **Equibase:** corrected action URL + field names + env-var fallback +
  GET-the-form-first (to capture `COOKIE_TEST`/Incapsula cookies before the POST).
  Detect the `eebErrorNoCookies.cfm` / Incapsula-challenge response and raise a
  clean, actionable error (`Equibase login blocked by bot protection (Incapsula)`).
- **Brisnet:** corrected env-var fallback + a `405`-aware path: when the login
  POST returns 405 with an `Allow` header that excludes POST, we stop hammering
  POST and report that the login endpoint has moved/disabled, with a clean error
  (`Brisnet login endpoint no longer accepts POST (HTTP 405; Allow: GET, HEAD,
  OPTIONS) — endpoint migrated to object storage`).
- **PullCardModal:** structured per-source error UI + Copy-diagnostics +
  partial-success draft handling, so Ken immediately sees *which* source failed
  and *why* (bot-wall vs creds vs endpoint move) instead of a blank failure.

**Bottom line for Ken:** the upstream sites changed — Equibase added an Imperva
bot-wall + consent gate on the premium login, and Brisnet moved its login/download
to Akamai object storage that no longer accepts the old POST login. The code bugs
(wrong URL/fields/env names) are fixed, but the auto-ingest cannot pass the new
bot protection from a headless server fetch. Manual PP upload still works; an
anti-bot-capable fetch path (headless browser / scraping service) is the next step
if hands-off ingest is required.
