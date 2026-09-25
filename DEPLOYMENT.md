# Deployment Guide — Cyber Tambola Game

This document covers deploying the `deployment` branch to Vercel, with Supabase as
the backend. It does not cover local gameplay development — see `README.md` for that.

Target architecture:

```
Vercel (static hosting)
   ↓
React + TypeScript + Vite frontend (this repo)
   ↓
Supabase
   ↓
Postgres + Realtime (cross-device authority)
```

The deployed app must work with the Host, each Player, and the Presentation
screen all on **different networks** (office Wi-Fi, mobile data, home Wi-Fi,
etc.) — there is no LAN/same-network requirement once deployed.

## Prerequisites

- Node.js (v18+ recommended) and npm
- Git, with push access to this repository
- A Supabase project (existing project reused from local development is fine)
- A Vercel account with access to import this GitHub repository

## Required Environment Variables

The app reads exactly two environment variables, both **browser-safe** (never
put a `service_role` key or any other secret in these):

| Variable                  | Description                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`        | Your Supabase project URL, e.g. `https://xxxxxxxxxxxx.supabase.co`   |
| `VITE_SUPABASE_ANON_KEY`   | The Supabase **anon/public** key (Settings → API). Never the service_role key. |

If these are absent, the app falls back to a local-only, single-browser demo
mode (no Supabase, no cross-device sync) — useful for offline UI work, but
**not** suitable for a real multi-device game.

See `.env.example` for the exact template.

## Local Validation (run before every deploy)

```powershell
npm install
npm run build
npm run preview -- --host
```

Then check in a browser (and on a phone on the same network, for a quick
sanity check before doing the real cross-network test below):

- `http://localhost:4173/`
- `http://localhost:4173/host`
- `http://localhost:4173/player`
- `http://localhost:4173/presentation`

All four must load directly (not just via in-app navigation) with no 404.

## Vercel Setup

1. Import this GitHub repository into Vercel.
2. **Select the `deployment` branch** as the branch to deploy from (Vercel's
   default "Production Branch" setting) — do **not** deploy from `main`.
   `main` is the stable prototype/review branch and should not be wired to
   any Vercel project for this work.
3. Framework preset: **Vite**.
4. Build command: `npm run build` (project default — already `tsc -b && vite build`).
5. Output directory: `dist` (Vite default).
6. Add the environment variables listed above under Project Settings →
   Environment Variables, for both **Production** and **Preview** environments.
7. Deploy.

A `vercel.json` is included at the repo root with a catch-all SPA rewrite, so
direct/refreshed loads of `/host`, `/player`, and `/presentation` resolve to
the app instead of a Vercel 404 (the app uses `react-router-dom`'s
`BrowserRouter`, which requires this on static hosts).

## Production Routes

Once deployed, these must all load directly in a browser (not just via
in-app links):

- `https://<your-domain>/` — Player Join
- `https://<your-domain>/host` — Host Dashboard
- `https://<your-domain>/player` — Player Game screen
- `https://<your-domain>/presentation` — Presentation/projector view

## QR Code / Join Link

The Join QR code and link are generated from `window.location.origin` at
runtime (`src/components/common/JoinQrCode.tsx`), so they automatically point
at whichever domain the app is actually running on — no code change or env
var is needed between local development and the deployed Vercel domain.

## Cross-Network Test (do this before trusting a live event)

1. Open the Host Dashboard on a laptop on one network (e.g. office Wi-Fi) and
   start/reset a game to get a fresh game code + QR.
2. On a phone using **mobile data (4G/5G)** — not the same Wi-Fi — either
   scan the QR code or open the deployed `/` URL and type in the game code.
3. Confirm the phone joins, receives the ticket, and Cyber Words called from
   the Host reach it in real time.
4. Open `/presentation` on a third device/browser (any network) and confirm
   it also updates live as words are called and winners are confirmed.
5. Submit a Claim from the phone; confirm it appears on the Host's Claims
   inbox and that confirming it updates both the phone and the presentation
   view without a manual refresh.

## Supabase Access Model (already in place, unchanged by this deployment)

- Row Level Security is enabled on every shared table (`games`,
  `called_terms`, `players`, `tickets`, `marks`, `claims`, `winners`,
  `active_game_pointer`).
- The anonymous (`anon`) role has **read-only** access (`SELECT`) on all of
  them. There is no `INSERT`/`UPDATE`/`DELETE` policy for `anon` on any
  table, by design.
- All writes go through `SECURITY DEFINER` RPC functions (e.g. `join_game`,
  `call_next_word`, `submit_mark`, `confirm_claim`, `reset_game_to_new`),
  which run with elevated privilege only after their own explicit checks
  (e.g. a host-only RPC checks the caller's `host_secret` against the row).
- The prototype intentionally uses anonymous access with no Supabase Auth —
  this keeps Join frictionless (no signup) but means anyone with a valid game
  code can join as a player, and anyone who captures a Host's `host_secret`
  could act as Host. This is an accepted trade-off for an internal awareness
  game with disposable game codes reset per session; it should be revisited
  before extending this app to anything higher-stakes.

Do not weaken these policies to "make deployment easier" — the current model
already supports the deployed anonymous-access use case correctly.

## Known Limitations

- No automated migration deployment: any future Supabase schema/RPC change
  must be applied manually to the live Supabase project (no CI/CD migration
  runner exists in this repo yet).
- Anonymous access model (see above) means game codes are the only access
  control; treat them as short-lived, not secret-for-life.
- One pre-existing, intermittent integration test
  (`GameSessionContext.multiTabReset.integration.test.tsx`) occasionally
  fails under full-suite load due to timing sensitivity; it passes in
  isolation and is not a deployment blocker.
