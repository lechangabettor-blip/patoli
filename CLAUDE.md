# Patoli — app repo context (created 2026-10-14)

LeChanga's own social betting platform, built solo with Claude Code. Business
context: `Desktop\LeChangaHQ\CLAUDE.md`; the product plan is
`Desktop\LeChangaHQ\5-lechanga-bet\PLAN.md` v2.0 (read §2 product and §5 roadmap
before adding features); decision history in `MVP-PLAN.md` next to it.

## Current state (2026-10-29) — read this before the older sections

- LIVE at https://patoli.bet on Vercel Pro; Supabase wired; Arena v2 live; 0.5% builder fee live.
- Wallet SDKs (Magic, ethers v5, Polymarket clients) are lazy: `src/lib/sdk.ts` loads them only
  on the login pages or for a remembered login (`patoli.auth` flag in localStorage). Anonymous
  readers download ~1.1 MB of JS instead of 3.9 MB. Everything else imports only TYPES from
  those packages — keep it that way.
- Prices, order book, builder fee and positions (Data API v2) are read straight from Polymarket
  in the browser (`src/lib/polymarket/public-api.ts`, CORS is open); `/api/prices`, `/api/book`,
  `/api/polymarket/fees`, `/api/positions` remain only as fallbacks.
- One bet sheet per page: `src/lib/bet-store.ts` + `BetSheetHost` (tabs layout and public
  profiles). Any button calls `openBet(selection)`.
- First bet in one tap: the sheet runs `setupTrading` and then the order in the same tap
  (`getClobClient()` returns the client built inside activation, before React re-renders). A pick
  tapped while logged out is stashed (`src/lib/pending-pick.ts`) and reopened on the game page
  after login. USDC that lands is wrapped to pUSD automatically (`AutoSettle`; a never-activated
  account that receives money is activated first, silently); the sheet, the tip sheet and the
  Convertir card wrap on the way too, so "deposit, then bet" is one tap. The Convertir card stays
  as the fallback.
- Feed paging: `/api/feed` returns `nextBefore` computed from its two sources' tails (inclusive
  cursor, client drops repeats by id); never derive the cursor from the merged list.
- Link previews: `src/app/u/[handle]/opengraph-image.tsx` renders the record card (next/og,
  Satori: every box with several children needs `display: flex`, text boxes get ONE template
  string). `metadataBase` = https://patoli.bet in the root layout.
- Fee rule: Polymarket's `feeUsdc` INCLUDES the builder fee. Cost of a bet = `usdc + fee_usdc`
  everywhere (indexer P&L, feed stake/odds, rolling windows, `profile_stats.staked`). Migration
  0012 backfilled settled P&L. A void (split payout) pays 1/n per share, so void BUY rows carry
  that real P&L (Unidades stay 0); migration 0013 counts voids in `staked`.
- Relayer batches: every `resp.wait()` goes through `confirmed()` in TradingProvider (undefined =
  reverted or unconfirmed → throw); wraps are coalesced per (wallet, amount) so AutoSettle, the
  sheets and Convertir share one batch; after any wrap/redeem/withdraw/tip
  `forgetCollateralSync()` (lib/polymarket/clob-cache.ts) makes the next order re-sync the CLOB
  balance. The bet sheet's whole submit is one in-flight unit (`sending`).
- Settlement sweep: every pass settles ALL open bets whose market has a `winning_index`
  (embedded inner-join filter), not only markets resolved in that run. Lock-table errors are
  pushed to `errors` + alerted, never fatal; the instant Arena settle runs inside `after()`.
- One clock: Vercel crons every minute, serialized by `job_locks` leases (`src/lib/job-lock.ts`:
  indexer, arena sweep, every operator send). Ops alerts to Telegram once
  `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` exist (indexer errors, settle errors,
  operator POL below 0.5).
- `/terminos` exists; `error.tsx` / `global-error.tsx` show "Reintentar"; iOS top safe area
  (`--safe-t`); sheets scroll internally; the feed paginates on scroll; search is debounced.
- Verified Polymarket facts (2026-10-29, `LeChangaHQ/5-lechanga-bet/PATOLI-RESEARCH-2026-10-29.md`):
  both SDKs we use are DEPRECATED in favour of `@polymarket/client` (viem); Protocol V2 markets
  (`version: "v2"`, `positionIds`) tentatively become the default for NEW markets on 2026-11-02
  and our normalisers skip them until a v2 path exists (next job); GTD expiration ≥ 3 min ahead
  (guarded in `placeLimit`); `POST /prices` takes mixed sides in one body; the market websocket
  takes `{operation: subscribe|unsubscribe}` frames (price-socket no longer reconnects); Data API
  v2 `redeemable` includes LOST positions (auto-cobro redeems only value); Unverified builders get
  100 relayer txs/day (429 `quota exceeded`); builder fees pay out daily (previous UTC day, min
  $0.10) to the builder-profile wallet; Magic email/Google linking is contradictory in Magic's
  docs — test before relying on one wallet per person.
- Full audit and plan: `LeChangaHQ/5-lechanga-bet/PATOLI-AUDIT-2026-10-28.md` (§9 = what shipped).

## What this is (v1 scope — the contract)

Mobile-first PWA, Spanish (es-MX, "banda" tone), decimal odds, brand = the
lechanga.com palette (tokens in `src/app/globals.css`). Five tabs, Instagram
style bottom nav:

1. **Inicio** — feed of other people's bets and results.
2. **Deportes** — Polymarket game markets by league (Liga MX, NFL, NBA, MLB,
   Champions, Premier, La Liga): moneyline / spread / total, live CLOB prices.
   MLB added 2026-10-27 (tag 100381, ESPN baseball/mlb, period "f5" = 1ras 5 entradas,
   nicknames via TEAM_OVERRIDES).
   Soccer swaps the spread for "Ambos anotan" (both teams to score) — LeChanga, 2026-10-16.
3. **Batalla** (center) — piedra-papel-tijera P2P, one $1 lobby, best of 3,
   winner takes $2, no house, no rake.
4. **Buscar** — users or games.
5. **Perfil** — record, open bets, deposit address, account activation.

Non-custodial by design: users log in with email/Google (Magic), get an
embedded EOA + a Polymarket deposit wallet on Polygon (deployed gaslessly by
Polymarket's relayer), and place orders themselves with our **builder code**
attached (0.5% builder fee live since 2026-10-24, max 1%). We never hold funds
or keys. PvP runs on the "Arena" contract (off-chain signed moves, batched
settlement) — live since 2026-10-20 (v2).

OUT of v1: own order book, hedging, fiat, token, comments/DMs, native apps,
live betting, picks marketplace.

## Stack

Next.js 16 (App Router, `cacheComponents: true`, Turbopack) · React 19 ·
TypeScript · Tailwind v4 (tokens via `@theme inline`) · TanStack Query ·
motion · lucide-react · Magic SDK (+ OAuth2 ext) · ethers v5 (what
Polymarket's SDKs expect) + viem · `@polymarket/clob-client-v2` (V2 orders; the old `clob-client` is rejected with "invalid order version"),
`@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk` ·
Supabase (Postgres through PostgREST, service role from server code only; migrations in
`supabase/migrations`, applied by LeChanga in the SQL editor — the code must tolerate the
newest one not being applied yet).

## Layout

```
src/app/(tabs)/            tab pages + shared layout with BottomNav
src/app/entrar             login · src/app/oauth/callback  Google redirect
src/app/u/[handle]         public profile
src/app/api/games          Gamma → normalized games (server)
src/app/api/games/[slug]   one game
src/app/api/prices         CLOB bid/ask proxy (POST tokenIds)
src/app/api/positions      Data API v2 positions (fallback; the browser reads Polymarket directly)
src/app/api/polymarket/sign  builder HMAC signing (secret stays server-side; logged-in users only)
src/lib/sdk.ts             lazy loader for Magic + ethers + Polymarket clients (+ the auth flag)
src/lib/polymarket/public-api.ts  direct-from-browser reads: prices, book, builder fee, positions v2
src/lib/bet-store.ts       the single bet sheet (openBet / BetSheetHost)
src/lib/pending-pick.ts    the pick kept across login
src/lib/job-lock.ts        Postgres lease locks (job_locks) · src/lib/alert.ts  Telegram ops alerts
src/providers/             WalletProvider (Magic→ethers signer), TradingProvider
                           (Safe deploy, API creds, approvals, ClobClient)
src/lib/polymarket/        constants, leagues (tag ids), gamma (board), game-detail
                           (game page), gamma-raw (ONE copy of the raw Gamma types,
                           parsers, team names, 3-way merge — shared by both + indexer),
                           odds (fee math), v2 (deposit-wallet batches)
src/lib/ttl-cache.ts       the in-memory memo used by gamma, game-detail and scores
src/components/            screens + UI primitives
```

## Rules

- Audience copy in es-MX, short, no exclamation marks; numbers `tnum`.
- Never hardcode fees: `PATOLI_BUILDER_FEE_BPS` / `POLYMARKET_SPORTS_FEE_RATE`.
- Odds shown are net of BOTH fees (Polymarket's per-market fee + Patoli's builder fee).
  Mercado shows no fee lines (LeChanga, 2026-10-28: the typed stake is what leaves the
  wallet); Límite shows one "Comisión" line. Orders are capped at the on-screen price.
- Money math: Polymarket's `feeUsdc` on a fill ALREADY includes the builder fee. What a bet
  cost = `usdc + fee_usdc`; never add `builder_fee` on top (fixed 2026-10-29, migration 0012).
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
  Neg-risk markets (soccer 1X2) spend via the NegRiskAdapter `0xd91E…5296`: it needs a pUSD
  allowance + CTF operator approval too (the CLOB rejects with "spender 0xd91E… allowance: 0"
  otherwise). `ensureApprovals()` tops up missing permissions before every order.
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
  (dead since Oct 2026, returns 401). Since 2026-10-19 the RPC is LeChanga's **Alchemy**
  app (Polygon Mainnet, key in `.env.local` `NEXT_PUBLIC_POLYGON_RPC_URL` and `arena/.env`);
  thirdweb keyless is the fallback if the key is missing. publicnode/drpc work for us but NOT
  inside Magic.
- Without `POLYMARKET_BUILDER_*` env vars, `/api/polymarket/sign` returns 503 and
  the relayer answers 401 → Safe deploy fails. The UI reads `GET /api/polymarket/sign`
  and disables "Activar" with a plain message. Login itself works without them.
- Magic free tier allows 1 allowed domain; set it to patoli.bet when deploying.
- **Native USDC** (`0x3c49…3359`) is a valid pUSD asset but the Onramp has it PAUSED
  (on-chain 2026-10-16). Perfil detects stray native USDC and rescues it:
  direct wrap if unpaused, else a gasless transfer to the user's own Polymarket
  bridge address (`POST bridge.polymarket.com/deposit`, via `/api/polymarket/bridge-address`),
  which converts to pUSD. Bridge also takes USDT/DAI/POL on Polygon (min $2).
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
- **Battles in the feed (2026-10-19):** `loadBattles` turns finished Arena matches into
  `FeedItem`s (`kind: "battle"`, market `Batalla`, both handles shown — PvP is head-to-head;
  the "never show counterparties" rule applies to pool-matched sports bets only). `/api/feed`
  and `/api/users/[handle]` merge bets + battles by time (`mergeFeed`). `PublicProfile.battles`
  comes from the `arena_stats` view. Share card = the same Boleto (league "Batalla").
- **APIs:** `/api/feed`, `/api/users?q=`, `/api/users/[handle]`, `/api/follow`.
  Without Supabase configured they answer 503 / empty (no demo data since 2026-10-20) and
  the UI shows empty states. Types in `src/types/social.ts`.
- **Client:** `MeProvider` syncs the profile after login; `useSocial` hooks;
  `FeedCard`/`HomeFeed`/`PublicProfile`/`SearchScreen` consume the APIs.
- **Súbaseee / Bájeseee (2026-10-27):** every open sports pick of someone else shows two
  buttons (`TailButtons.tsx`, inside `FeedCard`). Tail = same token; fade = the market's
  other token (`FeedItem.fadeTokenId`, from `markets.outcomes`) — on a soccer 1X2 pick that
  is the No side, i.e. "Rival o Empate" in the Doble oportunidad market. On tap the client
  pulls the game's markets (`fetchGameDetail` through the query cache), finds the token and
  opens the normal `BetSheet` with `Selection.source = {betId, side, handle}`; closed market
  / no asks → inline "Mercado cerrado" / "Sin liquidez". Once the order really fills the sheet
  POSTs `/api/react {kind: "tail"|"fade"}` (same `reactions` table as 🔥, told apart by
  `kind`) and the counts (`tails`/`fades`, `tailed`/`faded`) ride along with `attachFire`.
  **Server-verified:** the row is written only if `bets` holds a BUY by the viewer on that
  token after the source pick, by someone other than its author, while the pick is open
  (`verifyTail`); each reaction is tied to one specific fill (`reactions.proof_bet_id`,
  unique — migration 0010), so one bet cannot prove tails on several picks; 202 until the
  indexer has an unspent fill (`useRecordTail` retries), never deletable. Hidden on your own picks, on Batalla, and on settled picks.

## Tips (2026-10-27)

- **Tip** button on every public profile that is not yours (`TipSheet.tsx`): one typed amount
  (`TIP_MAX_USD` = 100, min 1, no presets by his choice), confirm step, then a gasless batch with a
  single pUSD `transfer` from the tipper's deposit wallet to the recipient's `profiles.wallet`
  (`TradingProvider.tip`). No Patoli fee. Irreversible.
- **Private:** never a feed item. `POST /api/tip {txHash, to}` reads the receipt on Polygon and
  records the tip only if it finds a pUSD Transfer from the viewer's wallet to the recipient's
  (`tips` table, migration 0011, RLS with no public policy). The owner sees their own total via
  `/api/me` → `MeProfile.tipsReceived` ("tips recibidos" line in Perfil; returned by POST and GET
  since 2026-10-29 — the app only ever POSTs).
- **Dinero tab (own Perfil → Historial, 2026-10-27):** `GET /api/me/money` → `loadMoney`
  (`src/lib/money.ts`) reads every USDC.e/USDC/pUSD transfer of the deposit wallet through
  Alchemy `alchemy_getAssetTransfers` (both directions, ≤3 pages, 30 s cache) and keeps only
  user actions: Depósito (stable in from outside), Retiro (pUSD to the offramp / burn), Tip a/de
  @handle (other users' deposit wallets, labelled from `tips`), A/De Batalla (forwarder / Arena).
  Exchanges, adapters, CTF, onramp and mints are plumbing and hidden (bets show as picks).
  Never on a public profile.

## Profile stats (2026-10-22)

- **Rolling windows** (`loadWindows` in social.ts, `StatsWindows.tsx`): últimos 7 días / 30 días /
  todo, counted by **settlement time** (`bets.settled_at`, migration 0009; battles use
  `finished_at`). Sports (récord, Unidades, P&L, ROI) and Batalla (w-l-d, P&L) are separate
  records — never mixed (LeChanga's rule). Computed from rows on every single-profile load; no
  snapshots. Lists (search, people rail) still use the all-time `profile_stats` view.
- Unidades = Σ won (1/price − 1) − lost (migration 0008). P&L = payout − (usdc + fee_usdc); Polymarket's fee already contains Patoli's (0012).
- Avatar ring on Inicio = has an open sports bet (`record.open > 0`), not ROI.
- Leaderboard ("Tabla") deliberately NOT built yet; when built: same three windows, min 3 settled
  picks in the window to rank.

## Game page — every market per game (2026-10-26)

- `/deportes/partido/[slug]` → `GameDetailScreen`; data from `/api/games/[slug]/markets` →
  `fetchGameDetail` (`src/lib/polymarket/game-detail.ts`): fetches the event AND its
  `<slug>-more-markets` companion (soccer keeps spreads/totals/BTTS/team totals there), drops
  closed / non-accepting markets, classifies `sportsMarketType` → kind + period + group + es-MX
  label. NBA raw event is ~1.6 MB → ~270 KB served (45 s memory cache, 30 s CDN).
- Kinds: moneyline · spread · total · team_total · btts · prop (player O/U; outcomes Yes/No =
  Más/Menos) · yesno (anything else, question translated). Period: full/1h/2h/q1–q4.
- Chips filter by group or period; sections = (group, period, stat|team). Ladders: spread =
  two team columns (column A = first-named team, `line` rewritten to column A's line so rows
  sort one way), total = Más/Menos; props = rows per player. Only open sections' tokens are
  polled (cap 200), 2 s live / 5 s prematch. Main line = most liquid, highlighted.
- Indexer stores richer kinds (`kindOf`: "spread_1h", "team_total", "prop_points", "yesno"…);
  `splitKind` in social.ts turns them into feed/ticket text. FeedItem.market gained "Prop".
- Dynamic pages under (tabs) must wrap the `params` await in Suspense (cacheComponents), as
  `/u/[handle]` does, or the build fails at prerender.

## Limit orders — Mercado | Límite (2026-10-28)

- Toggle top-right of the bet sheet, prematch only (hidden once kickoff is < 3 min away or
  the game is live). Mercado = the unchanged FOK path. Límite = Polymarket-style form:
  `LimitBook` (top of the book from `GET /api/book?tokenId`, 2 asks over 2 bids, polled 3 s;
  rows show ¢, net decimal odds — ask rows with taker fees, bid rows as maker: Patoli maker bps
  and `fee.takerOnly` → $0 Polymarket — and USD resting; tapping a row sets the price), then
  "Precio límite" with − / + per tick, "Shares" typed by the user (+10/+50/+100), and the money
  box: shares × price, fees, **Apuestas** (total leaving the wallet) and **Si gana cobras**
  (= shares; one "Comisión" line = Polymarket + Patoli). Default price = best bid. No free-text
  price. Book rows show **shares** resting, not dollars. **Mercado shows no fee lines at all**
  (his call, 2026-10-28): the stake typed is what leaves the wallet, shares = stake / all-in cost
  per share, so the net odds already carry both fees. The sheet headline is the side ("Panthers")
  with the line + market under it ("+3.5 · Hándicap"); ladder buttons pass the full outcome.
- `usePlaceBet.placeLimit` → `createAndPostOrder(…, GTD)` with `expiration` = kickoff (unix s),
  size = shares (≥ market min, 5). A price at/above the best ask fills at once (`matched`) and
  syncs like a market bet; otherwise "Orden puesta". Resting orders: `useOpenOrders`
  (`clobClient.getOpenOrders`), cancel via `useCancelOrder`; listed in Perfil (`LimitOrders`,
  labels from `POST /api/markets/lookup`) and inside the sheet when one exists on that token.
  Fills reach the feed through the indexer like any other fill — nothing is public until it fills.

## Speed (2026-10-28)

- Odds: src/lib/polymarket/price-socket.ts keeps ONE websocket to wss://ws-subscriptions-clob.polymarket.com/ws/market for every token any mounted component watches (ref-counted, reconnects with the full list, 250 ms debounce, PING every 10 s, backoff on close). usePrices overlays its best bid/ask (fresh < 60 s) on the REST poll, which slows to 20 s while the socket is open. Verified shapes: book snapshot on subscribe; price_change.price_changes[] with best_bid/best_ask per asset_id.
- Game page prefetch: GameCard warms /api/games/[slug]/markets via IntersectionObserver after 400 ms on screen.
- Clocks: Vercel Pro crons every minute (indexer + arena settle) are the ONLY clock since 2026-10-29 (cron-job.org retired 2026-10-28, the GitHub Actions workflow deleted 2026-10-29). Overlapping runs are serialized by Postgres leases (`job_locks`, migration 0012, `src/lib/job-lock.ts`). LeChanga rejected provisional results from ESPN finals: nothing shows as won until Polymarket pays.

## Live bets (2026-10-21)

- Board keeps in-play games until kickoff + max duration per sport (`MAX_GAME_MS` in gamma.ts:
  soccer 2h15, basketball 3h, football 4h); `isLive()` in format.ts drives the "En vivo" pill.
- Prices: `usePrices(tokenIds, 2000 | 5000)` — 2 s while any listed game is live. Structure
  (Gamma) stays cached 45 s + CDN 30 s; only prices need to be fresh.
- Order = FOK market order **capped at the on-screen price** (`price` in PlaceBetParams →
  UserMarketOrderV2.price). Fills at that price or better, else the CLOB rejects and the sheet
  re-quotes (`lineMoved`). The bet sheet polls its own token while open, so "the price you tap"
  = "the price you confirm". No "aceptar cambios" dialog (LeChanga's call).
- Session shortcuts in usePlaceBet (`approvalsOk`, `collateralSynced`) skip the on-chain
  approval check and the CLOB balance poll after the first successful order; reset on a
  balance/allowance rejection. Saves ~0.5–1 s per bet.
- Scores: `src/lib/scores.ts` + `/api/scores?league=` — ESPN public scoreboard
  (site.api.espn.com, unofficial, no key; league paths in `ESPN_PATH`), 8 s server cache, client
  polls 10 s while any game is live (`useScores`). Team matching via `sameTeam` on ESPN's
  displayName/short/name/location, same-day window. Fallback = Polymarket's own event score
  (`Game.pmScore` from the embedded event: score/elapsed/period/live/ended, ~45 s behind).
  Score is shown in title order (first-named team first); Polymarket's "74-68" is title order too.
- CLOB WebSocket for odds: built 2026-10-28 (see Speed).

## Arena — PvP piedra·papel·tijera (built 2026-10-17, LIVE v2 since 2026-10-20)

> **2026-10-21 — settlement reconcile.** Instant settle and the cron sweep can run the same
> batch twice; the second run sees no `Settled` event and used to demote the match to
> `finished` ("omitida") — which froze a real user's $1 as "owed" (Ernesto, match
> `0x181fbe9d…`). Now `reconcileSettled` (engine.ts) asks the chain before demoting or claiming:
> a match is marked `settled` ONLY when its on-chain `Settled` event carries the row's players
> and stake (`arenaSettledEvent` in server.ts). `matchStatus[id]` alone proves nothing: ids are
> client-chosen, so a loser could pre-settle a forged match (his two wallets) under the same id
> and block the real one. Event scans use `polygon-bor-rpc.publicnode.com` (`ARENA_LOGS_RPC_URL`
> to override) in 10k-block windows from the finish block (Alchemy free tier caps getLogs at 10
> blocks). **Contract v3 TODO:** key `matchStatus`/`claims` by the full match digest, not `m.id`.
> Also: never run a local server/cron against the production DB — it becomes a second settler
> (`scripts/local-cron.ps1` and the `/arena/preview` dev page were deleted 2026-10-21).

- **Contract** `arena/contracts/PatoliArena.sol` (Hardhat 2, Solidity 0.8.28, cancun, viaIR;
  OpenZeppelin 5). Escrow token = pUSD. `deposit(amount, beneficiary)` is called by the
  Polymarket deposit wallet with beneficiary = owner EOA (the Magic key that signs). Balances
  are NOT locked per match (zero gas per match). Settlement: `settle`/`settleBatch` need the
  players' EIP-712 `Match` sigs + both `Result` sigs (anyone may submit). Dispute path after
  `Match.deadline`: `claim` with signed `Commit`s + reveals → contract replays the game;
  counter-claim needs strictly more evidence; `finalize` after 24h. Withdrawals:
  `requestWithdraw`→`finalizeWithdraw` (1h delay, no server) or `withdrawWithSig` (relayed).
  Owner can only set limits ($0.50–$20), pause deposits, rescue non-escrow tokens.
  Tests: `cd arena && npm test` (15 passing). Deploy: `npm run deploy:polygon` (needs
  `arena/.env` ARENA_DEPLOYER_KEY funded with POL) → writes `arena/deployments/polygon.json`;
  then set `NEXT_PUBLIC_ARENA_ADDRESS` in `.env.local`. Operator = same key as
  `ARENA_OPERATOR_KEY` (pays gas for settle batches + relayed withdrawals, never holds funds).
- **Off-chain engine** `src/lib/arena/engine.ts` on Supabase tables (migration
  `0003_arena.sql`: arena_lobby, arena_matches, arena_rounds, arena_round_secrets,
  arena_settlements, `arena_pair()` RPC, `arena_stats` view). Protocol: lobby → pair → both
  sign Match (silent Magic sig) → per round: commit (hash+sig, 15s) → reveal after both
  commits (15s; secrets kept server-side until both in) → score. **Nobody signs a result
  (LeChanga, 2026-10-19):** a match decided by score through revealed rounds becomes `ready`
  and the cron `/api/arena/settle` (every minute) calls `settleBatch` with the moves
  themselves; the contract replays them and pays (rock vs paper = loss, automatically).
  Forfeits/abandons → `finished` → operator `claim` after `Match.deadline` → `disputed` →
  `finalize` after 24h. `settled` is marked ONLY from `Settled` events in the receipt;
  skipped items go back to `finished` (claim path).
  **Engine rules == contract `_replay` rules** (missed commit/reveal with the other side
  delivered = match forfeit; nobody committed/revealed = ends on score). Timeouts applied by
  `tick` (clients call it when timers hit 0; the cron sweeps). If a loser never signs the
  Result, after `Match.deadline` the cron files the on-chain `claim` with all evidence
  (anyone may claim; evidence is player-signed) → `disputed` → `finalize` after 24h.
  **Operator acks:** signatures carry no clock, so the contract only counts commits/reveals
  that also carry the operator's `CommitAck`/`RevealAck` (server signs them when a move
  arrives in time; stored in `commit_ack_*`/`reveal_ack_*`). Trust assumption (stated, v1):
  the operator can CENSOR a move (liveness, same as not relaying) but can never FORGE a move
  or an outcome — every counted artifact is still player-signed. `finalizeClaims` refuses to
  pay when the on-chain claim winner differs from the engine's (`settle_error: revisar reclamo`).
  Guards (security review 2026-10-17): one open match per player enforced inside
  `arena_pair` (global advisory lock); `disputed` counts as an open status; both balances + pending withdrawals re-checked when a
  match goes signing→playing (else cancelled); relayed withdrawals refused while queued or
  in a match; signatures must be canonical 65-byte low-s (`isCanonicalSig`) so off-chain
  and on-chain verification can't diverge; `settle_error` holds generic codes only.
- **Client:** `useArena` hooks (realtime via Supabase browser client — the ONE place the
  browser talks to Supabase, read-only), `BattleArena` (shows "Muy pronto" when
  `NEXT_PUBLIC_ARENA_ADDRESS` is unset). Perfil shows the Arena balance + "Regresar todo a
  mi saldo" (withdrawWithSig to the deposit wallet). Local secrets in localStorage
  `arena:<matchId>:<round>` so a reload can still reveal.
- **Funding (verified 2026-10-19):** Polymarket's relayer REJECTS deposit-wallet batches that
  `approve` a spender outside its allowlist ("approve spender 0xa2B4… is not in the allowed
  list"). Plain pUSD `transfer`s are allowed. So funding = transfer to the user's
  `DepositForwarder` (CREATE2, salt = EOA, from `ArenaDepositRouter.forwarderOf`) + operator
  calls `router.sweep(user)` (`POST /api/arena/sweep`), which deploys the forwarder on first
  use and credits `Arena.deposit(amount, user)`. Router v2 `0x6418a4bf4251F66156EFa268384C7AB7aBF92638` (v1 `0x7253…ef28` retired, had `refund` missing)
  (`NEXT_PUBLIC_ARENA_ROUTER_ADDRESS`), stateless, no owner. `/api/arena/me` reports
  `waiting` (pUSD stranded in the forwarder) and the lobby shows "Acreditar" to finish.
- Live (v2, 2026-10-20): Arena `0xaE66Ab4c09FaefE9D8DF2f3e8C863dD476C69A30` + router `0xB808194D9e6b95457992Af9a5F73DDE766333d96`. v1 `0xa2B4…F612` retired (a $1 forfeit stake left inside by choice). Rule change in v2: a missed commit/reveal loses the ROUND, nobody-played = tie; first to the needed points wins and settles instantly. (owner = LeChanga's MetaMask
  `0x22F9…b5Ea`, operator = server key `0xC16B…2296`). Owner console: `/arena/owner`.
- Still unverified on a real run: Magic signs `eth_signTypedData_v4` silently; Realtime
  publication includes the tables.

## Deployment (2026-10-20)

- **Vercel** project `patoli` (team `lechangabettor-gmailcoms-projects`, Pro plan since 2026-10-28), linked
  from this folder (`.vercel/` ignored). Production: https://patoli.vercel.app → custom
  domain `patoli.bet` + `www` attached; DNS at Wix must point A `@` → `216.198.79.1` and
  `64.29.17.1`, CNAME `www` → `13e4e9175fae5c3d.vercel-dns-017.com`. Deploy = push to
  `main` (Git integration) or `npx vercel --prod`. Env vars pushed from `.env.local` with
  `vercel env add` (strip `\r`; `NEXT_PUBLIC_MAGIC_API_KEY` / `…SUPABASE_ANON_KEY` need
  `--type config`). `CRON_SECRET` set.
- **Crons (2026-10-29):** `vercel.json` runs `/api/indexer/run` and `/api/arena/settle` every
  minute with `CRON_SECRET` as bearer. cron-job.org and the GitHub Actions workflow are gone.
  Instant settlement at match end does not depend on crons. Each run takes a Postgres lease
  (`job_locks`), so a user's post-bet sync or an instant settle can never overlap the cron.
- **Magic:** allowed origins set (the free plan accepted several): `https://patoli.bet`,
  `https://www.patoli.bet`, `https://patoli.vercel.app`, `http://localhost`.
- **GitHub secrets** `APP_URL` + `CRON_SECRET` set; the cron workflow ran green (manual run #3).
  DNS at Wix was edited 2026-10-20 (A ×2 + CNAME); Vercel verified, certs issued. Google social login configured (Google Cloud project
  "Patoli", redirect `https://auth.magic.link/v1/oauth2/google/callback`).

## Status log

- 2026-10-14 — Phase 0 scaffold: brand, nav, 5 tabs, Deportes live from
  Polymarket, bet sheet with fee breakdown, Magic login wiring, trading
  session port, Battle lobby with simulated rival (demo), demo feed/profiles.
  Not yet: Supabase schema, indexer (real feed/profiles), Arena contract,
  deploy to Vercel, Magic + builder keys (owner must create accounts).
