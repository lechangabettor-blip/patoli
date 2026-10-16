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
   Soccer swaps the spread for "Ambos anotan" (both teams to score) — LeChanga, 2026-10-16.
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

## Polymarket V2 facts (verified with a real $5 fill on 2026-10-14)

- **Accounts are "deposit wallets"** (since May 2026). Safe/Proxy makers are
  rejected for new accounts ("maker address not allowed, please use the deposit
  wallet flow"). Derive via `RelayClient.deriveDepositWalletAddress()`, deploy via
  `deployDepositWallet()`, run approvals/wraps/transfers via
  `executeDepositWalletBatch(calls, wallet, deadline)` (owner signs EIP-712
  "DepositWallet" batch; relayer pays gas; our builder key authorizes).
- **Orders:** `@polymarket/clob-client-v2` (the old `clob-client` is rejected with
  "invalid order version"), `signatureType: SignatureTypeV2.POLY_1271 (3)`,
  `funderAddress: <deposit wallet>`, `builderConfig: { builderCode }` (32-byte hex
  from polymarket.com → Settings → Builders; public; embedded in the order).
  Verify attribution: `GET clob.polymarket.com/builder/trades?builder_code=…`.
- **Collateral is pUSD** (`0xC011…2DFB`), not USDC.e. USDC.e → pUSD via
  CollateralOnramp `wrap(USDC.e, to, amount)` (approve the onramp first); we do it
  as a gasless batch from the deposit wallet (`buildWrapCalls`). Native USDC is a
  different token and is NOT handled yet.
- **CLOB balance cache:** call `updateBalanceAllowance({asset_type: COLLATERAL})`
  after deposits; it is async on their side (we poll briefly, never block).
- `RelayClient` builds its own viem public client from `options.chain` — pass
  `polygonChain` (our RPC) or it uses viem's default Polygon RPC, which is dead.
- Builder API key/secret/passphrase (server, HMAC via `/api/polymarket/sign`) are
  for the relayer. The builder CODE is for order attribution. Different things.

## Redeeming (Cobrar) — 2026-10-15

- CTF markets (all our sports markets today) redeem through Polymarket's
  **collateral adapters**: standard `0xAdA1…FcE1f`, neg-risk `0xadA2…eAab`, calling
  `redeemPositions(pUSD, 0x0, conditionId, [1,2])`; the adapter burns the outcome
  tokens and returns pUSD to the deposit wallet. Needs `setApprovalForAll` on CTF
  for the adapter (now part of the activation batch; `buildRedeemCalls` adds it on
  the fly for wallets activated before). "v2" position-based markets use the Router
  `0x1212…2600` `redeem(bytes31,uint256,uint256)` — not wired yet.
- Fully automatic redemption would need Polymarket **session keys** (owner grants a
  scoped signer); for now Perfil shows "Tienes $X listos → Cobrar", one signature.

## Gotchas learned the hard way

- Gamma `/markets?condition_ids=` drops CLOSED markets unless `closed=true` is
  passed (and open ones disappear when it is). The indexer queries both states;
  otherwise nothing ever settles.

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

## Social layer (added 2026-10-15)

- **DB:** Supabase Postgres, schema in `supabase/migrations/0001_init.sql`
  (profiles, profile_private, follows, markets, bets, reactions, indexer_state,
  view `profile_stats`). RLS: public read on social tables, writes only via the
  service role from server code. Browser never talks to Supabase.
- **Identity:** Magic DID token (`magic.user.getIdToken()`) sent as Bearer;
  verified server-side with `@magic-sdk/admin` (`MAGIC_SECRET_KEY`). `/api/me`
  creates the profile on first login (handle from email) and checks the claimed
  deposit wallet derives from the token's EOA (`wallet-derive.ts`).
- **Indexer:** `src/lib/indexer` reads `clob/builder/trades?builder_code=…`
  (every fill with our code, all users), caches market metadata from Gamma,
  settles bets when Gamma marks a market closed (`outcomePrices` 1/0; 50/50 =
  void). Trigger: `POST /api/indexer/run` with `x-indexer-secret`, or Vercel
  Cron with `CRON_SECRET`; open in dev. Idempotent, rebuildable.
- **APIs:** `/api/feed`, `/api/users?q=`, `/api/users/[handle]`, `/api/follow`.
  Without Supabase configured they serve the demo data (`lib/demo-feed.ts`) and
  flag `demo: true`, so the UI works in both modes. Types in `src/types/social.ts`.
- **Client:** `MeProvider` syncs the profile after login; `useSocial` hooks;
  `FeedCard`/`HomeFeed`/`PublicProfile`/`SearchScreen` consume the APIs.

## Status log

- 2026-10-14 — Phase 0 scaffold: brand, nav, 5 tabs, Deportes live from
  Polymarket, bet sheet with fee breakdown, Magic login wiring, trading
  session port, Battle lobby with simulated rival (demo), demo feed/profiles.
  Not yet: Supabase schema, indexer (real feed/profiles), Arena contract,
  deploy to Vercel, Magic + builder keys (owner must create accounts).
