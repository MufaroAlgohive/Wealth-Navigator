# Client View Impersonation — Mint app setup

Settings → **Client View Studio** in this admin portal lets an admin click a client and see the live Mint client app signed in as that client. The admin portal already does its half (mints a one-time magic link via Supabase, embeds it in an iframe). For the iframe to actually render, the **Mint client app** (the separate `MINT-DEVELOPMENT` repo) needs two small things:

## 1. Allow the admin portal to embed Mint in an iframe

By default most apps send `X-Frame-Options: DENY` (or `SAMEORIGIN`), and modern Vercel/Next deployments often add a CSP `frame-ancestors 'none'`. Both block iframe embedding completely — the iframe stays blank and the browser logs a `Refused to display … in a frame` error.

On the Mint app, allow this admin origin (and only this admin origin) to frame it. Pick the option that matches your stack:

**`next.config.js` (Next.js):**
```js
module.exports = {
  async headers() {
    const admin = process.env.ADMIN_PORTAL_ORIGIN || 'https://your-admin.replit.app';
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: `frame-ancestors 'self' ${admin}` },
        // Do NOT also send X-Frame-Options — modern browsers honor frame-ancestors.
      ]
    }];
  }
};
```

**`vercel.json`:**
```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Content-Security-Policy", "value": "frame-ancestors 'self' https://your-admin.replit.app" }
    ]
  }]
}
```

**Vite preview / any custom server:** set the same `Content-Security-Policy: frame-ancestors 'self' https://your-admin.replit.app` response header and remove any `X-Frame-Options` header.

Replace `https://your-admin.replit.app` with this admin portal's actual origin (no path, no trailing slash). When the admin portal is deployed under multiple domains, list them space-separated: `frame-ancestors 'self' https://a https://b`.

## 2. Auto-detect the magic-link session on load (almost always already on)

When the admin clicks a client, the iframe loads:

```
https://<your-supabase>.supabase.co/auth/v1/verify?token=…&type=magiclink&redirect_to=<MINT_APP_URL>/?admin_view=1
```

Supabase consumes the one-time token and 302-redirects to `<MINT_APP_URL>/?admin_view=1#access_token=…&refresh_token=…`. Any Mint page that initialises the Supabase JS client with the default `detectSessionInUrl: true` (the default) will pick up the tokens, write them to its session storage, and the user is signed in. No code change required — verify your Mint client init looks like:

```ts
createClient(url, anonKey, {
  auth: { detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
});
```

If your app passes `detectSessionInUrl: false` anywhere, flip it back to `true` on the entry route.

## 3. (Recommended) "Admin view" banner

The redirect URL appends `?admin_view=1` so the Mint app can recognise that this session was opened by an admin via Client View Studio (rather than the real client signing in themselves). The admin **keeps full action capability** — they can place orders, edit the profile, submit KYC, etc., exactly as the client would. The only requirement is a visual banner so the admin always knows they are *not* logged in as themselves.

Add this once near the app root:

```ts
// e.g. in App.tsx or _app.tsx
useEffect(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.get('admin_view') === '1') {
    sessionStorage.setItem('mint:admin_impersonation', '1');
    // Strip the query so refreshes inside the iframe stay clean
    url.searchParams.delete('admin_view');
    window.history.replaceState({}, '', url.toString());
  }
}, []);

export const isAdminImpersonation = () =>
  typeof window !== 'undefined' && sessionStorage.getItem('mint:admin_impersonation') === '1';
```

Then render the banner at the top of the app:

```tsx
{isAdminImpersonation() && (
  <div style={{background:'#fff7ed',color:'#9a3412',padding:'6px 12px',fontSize:12,fontWeight:600,textAlign:'center'}}>
    Admin view — you are signed in as this client. Any action you take is recorded against their account.
  </div>
)}
```

That's it — do **not** wrap buttons in `{!isAdminImpersonation() && …}`. Admins need full functionality (e.g. to help a client complete an order over the phone); the banner alone is enough to make it obvious which session you're in.

The admin portal also posts `{ type: 'mint:admin_signout' }` via `window.postMessage` to the iframe when the admin clicks **Exit client view**. If you want the Mint app to actively sign the impersonated user out of its iframe storage on exit, listen for it:

```ts
window.addEventListener('message', (e) => {
  if (e.data?.type === 'mint:admin_signout') {
    sessionStorage.removeItem('mint:admin_impersonation');
    supabase.auth.signOut();
  }
});
```

## Troubleshooting

- **Iframe stays blank, console says "Refused to display … in a frame"** → step 1 is missing. Check the Mint app's response headers for the page you're loading.
- **Iframe loads but shows the login screen** → step 2 is off (`detectSessionInUrl: false`), or the magic-link flow on Supabase is disabled. Re-enable "Email Magic Link" in Supabase Auth providers.
- **"Could not generate sign-in link: …"** in the admin → the target client either has no profile row or no email. The studio reads from `profiles.email` for the given `user_id`.
- **Tokens leak into the iframe URL hash** → that's by design (Supabase's magic-link flow); the tokens are consumed once by Supabase and the redirect lands on the Mint app. The hash is then cleared by Supabase JS on init. Nothing to do.
