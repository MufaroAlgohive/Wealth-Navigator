---
name: Server architecture
description: How the Mint CRM server is structured — routing, auth, patterns
---

## Stack
- Pure Node.js `http.createServer` — no Express, no framework
- Frontend: static HTML/JS/CSS in `public/`
- API handlers: CommonJS modules in `api/`, required in `server.js`
- Auth: Supabase Auth JWT; token parsed from `Authorization: Bearer` header and validated via `GET /auth/v1/user`

## Route pattern
```js
if (req.url.startsWith('/api/something')) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) { sendJson(res, 401, { error: '...' }); return; }
  (async () => {
    try {
      await fetchSupabaseJson('/auth/v1/user', token, false); // validates token
      await myHandler(req, res);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
  })();
  return;
}
```

## Key helpers (defined in server.js)
- `fetchSupabaseJson(path, token)` — GET from Supabase REST/Auth API
- `requestSupabaseJson(path, body, token, method)` — mutating calls
- `parseBearerToken(authHeader)` — extracts JWT from Authorization header
- `sendJson(res, status, body)` — JSON response helper

## Supabase access
- `SUPABASE_URL` — base URL (set as shared env var)
- `SUPABASE_SERVICE_ROLE_KEY` — service role key for admin operations (secret)
- Auth user listing requires service role: `GET /auth/v1/admin/users`

## Schedulers
All schedulers started in `startServer()` callback after server.listen:
- `startDailyOrderbookScheduler()` — daily CSV email
- `startMarketDataScheduler()` — Yahoo Finance price sync
- `startMintMorningsScheduler()` — Mint Mornings newsletter at 05:00 UTC
