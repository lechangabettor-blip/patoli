# Patoli — app repo context (created 2026-10-14)

LeChanga's own social betting platform, built solo with Claude Code. Business
context: `Desktop\LeChangaHQ\CLAUDE.md`; the product plan is
`Desktop\LeChangaHQ\5-lechanga-bet\MVP-PLAN.md` (read §2 scope and §10
decisions before adding features). Partner-era research: `Desktop\Patolli\`.

## What this is (v1 scope — the contract)

Mobile-first PWA, Spanish (es-MX, "banda" tone), decimal odds, brand = the
lechanga.com palette (tokens in `src/app/globals.css`). Five tabs, Instagram
style bottom nav:

1. **Inicio** — feed of other people's bets and results.
2. **Deportes** — Polymarket game markets by league (Liga MX, NFL, NBA,
   Champions, Premier, La Liga): moneyline / spread / total, live CLOB prices.
3. **Batalla** (center) — piedra-papel-tijera P2P, one $1 lobby, best of 3,
   winner takes $2, no house, no rake.
4. **Buscar** — users or games.
5. **Perfil** — record, open bets, deposit address, account activation.

Non-custodial by design: users log in with email/Google (Magic), get an
embedded EOA + a Safe on Polygon (deployed gaslessly by Polymarket's relayer),
and place orders themselves with our **builder code** attached (fee up to 1%).
We never hold funds or keys. PvP will use the "Arena" contract (off-chain
signed moves, batched settlement) — not built yet.

OUT of v1: own order book, hedging, fiat, token, comments/DMs, native apps,
live betting, picks marketplace.

## Stack

Next.js 16 (App Router, `cacheComponents: true`, Turbopack) · React 19 ·
TypeScript · Tailwind v4 (tokens via `@theme inline`) · TanStack Query ·
motion · lucide-react · Magic SDK (+ OAuth2 ext) · ethers v5 (what
Polymarket's SDKs expect) + viem · `@polymarket/clob-client-v2` (V2 orders; the old `clob-client` is rejected with "invalid order version"),
`@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk` ·
Supabase (not wired yet).

## Layout

```
src/app/(tabs)/            tab pages + shared layout with BottomNav
src/app/entrar             login · src/app/oauth/callback  Google redirect
src/app/u/[handle]         public profile
src/app/api/games          Gamma → normalized games (server)
src/app/api/games/[slug]   one game
src/app/api/prices         CLOB bid/ask proxy (POST tokenIds)
src/app/api/positions      Data API positions proxy
src/app/api/polymarket/sign  builder HMAC signing (secret stays server-side)
src/providers/             WalletProvider (Magic→ethers signer), TradingProvider
                           (Safe deploy, API creds, approvals, ClobClient)
src/lib/polymarket/        constants, leagues (tag ids), gamma (normalize),
                           odds (fee math), approvals, session
src/components/            screens + UI primitives
src/data/demo.ts           DEMO content (handles end in _demo) until indexer
```

## Rules

- Audience copy in es-MX, short, no exclamation marks; numbers `tnum`.
- Never hardcode fees: `PATOLI_BUILDER_FEE_BPS` / `POLYMARKET_SPORTS_FEE_RATE`.
- Prices shown = Polymarket market price, Polymarket fee, Patoli fee, your
  price — always separately (see `BetSheet`). Never hide a bad spread.
- Demo data must stay obviously fake; never present it as real records.
- Secrets only in `.env.local` (see `.env.example`). Builder secret never
  reaches the client. Never reuse ArbClaude's wallet or keys.
- Next 16 gotchas: `params`/`searchParams` are Promises; `useSearchParams`
  needs a Suspense boundary; route handlers use `RouteContext<"/api/…">`.
- Verify UI on a 390px-wide viewport (Playwright / browser pane) before
  calling anything done.

## Gotchas learned the hard way

- **Polygon RPC must be on Magic's CSP allowlist** (Magic's iframe blocks other
  hosts): `*.alchemy.com`, `*.infura.io`, `*.rpc.thirdweb.com`, `polygon-rpc.com`
  (dead since Oct 2026, returns 401). Default is thirdweb keyless; use an Alchemy
  key in prod. publicnode/drpc work for us but NOT inside Magic.
- Without `POLYMARKET_BUILDER_*` env vars, `/api/polymarket/sign` returns 503 and
  the relayer answers 401 → Safe deploy fails. The UI reads `GET /api/polymarket/sign`
  and disables "Activar" with a plain message. Login itself works without them.
- Magic free tier allows 1 allowed domain; set it to patoli.bet when deploying.
- Dev server is slow on phones (unminified bundles); test on the phone with
  `npm run build && npm run start -- -H 0.0.0.0`.

## Status log

- 2026-10-14 — Phase 0 scaffold: brand, nav, 5 tabs, Deportes live from
  Polymarket, bet sheet with fee breakdown, Magic login wiring, trading
  session port, Battle lobby with simulated rival (demo), demo feed/profiles.
  Not yet: Supabase schema, indexer (real feed/profiles), Arena contract,
  deploy to Vercel, Magic + builder keys (owner must create accounts).
