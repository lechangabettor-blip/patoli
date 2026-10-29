# Patoli — full audit and lean plan (2026-10-28)

Scope: every file of `Desktop\patoli` (122 source files, ~11.4k lines, 39 route handlers, the
Hardhat project in `arena/`), read by six independent reviewers (one per subsystem), then the
money-, security- and API-critical findings verified by hand against the code and live
Polymarket endpoints. Ordered by LeChanga's priorities: user experience, functionality, lean.
Strategy context: `PLAN.md` v2.0 (which this audit shows is stale in §0 and §3 — see §7).

**Done today, in production:** the remote-signing route was open to the internet (anyone could
get Patoli's builder API key, passphrase and a valid signature). It now requires a logged-in
user and only signs the relayer's own endpoints. Bets never used that route, so they were never
affected; activation, convertir, retiro, tips, Arena funding and auto-cobro do, and need one
real test from a phone after this change.

---

## 1. How Patoli works today (the map)

**Identity and money.** Email OTP or Google through Magic gives each user an embedded Polygon
EOA. From that EOA the app derives a Polymarket **deposit wallet** (relayer SDK), deploys it
gaslessly through Polymarket's relayer (authenticated with Patoli's builder HMAC via
`/api/polymarket/sign`), derives CLOB API credentials with one signature, and sets eleven
approvals in one batch. Funds: USDC/USDC.e arrive in the deposit wallet, are wrapped to pUSD
(gasless), bets are signed by the EOA with the deposit wallet as funder (EIP-1271). Patoli never
holds funds or keys. Withdrawals unwrap pUSD to USDC.e. Tips are plain pUSD transfers between
deposit wallets, verified from the on-chain receipt before being recorded.

**Markets and odds.** Three server normalisers turn Polymarket's Gamma payloads (up to 1.6 MB
per event) into tens of KB: the league board (`gamma.ts`), the game page with every market and
real asks plus depth from the order book (`game-detail.ts`), and one shared copy of the raw
parsing (`gamma-raw.ts`). Prices: one websocket to Polymarket's market channel for every
visible token, overlaid on a REST poll that slows to 20 s while the socket is open. Fees per
market from Gamma (`feeSchedule`, taker-only on sports) plus the live builder fee; `odds.ts`
produces the net decimal odd shown everywhere and matches Polymarket's own fee math exactly.
Scores from ESPN with Polymarket's event score as fallback.

**Orders.** Mercado = fill-or-kill market order capped at the on-screen price (fills at that
price or better, or the sheet re-quotes). Límite = good-till-date limit order that expires at
kickoff, with the top of the book shown in cents, odds and shares. Resting orders are listed
and cancellable in Perfil. **The CLOB signs V2 orders today (`/version` = 2).** ExchangeV3
exists in the installed SDK and is adopted automatically when Polymarket flips the version;
nothing in Patoli is V1.

**Record and social.** The indexer reads Polymarket's builder-trades feed every minute (Vercel
cron), writes bets keyed by trade id, caches market metadata, and settles from the Conditional
Tokens payout vector with Gamma as fallback. Everything public is a read model over that:
feed, profiles with 7/30-day/all-time windows by settlement date, Unidades, the week's table on
Inicio, Súbaseee/Bájeseee counts bound to a real fill, tips, the private Dinero tab (Alchemy
transfer history). The browser never writes to Supabase.

**Batalla.** Two players, $1, best of three. Funds move deposit wallet → per-user forwarder →
Arena escrow (operator sweeps). Moves are signed EIP-712 commits and reveals acknowledged by the
operator; a finished match settles by replaying the moves on-chain, so Patoli can delay but
never forge a result. Forfeits go through claim → 24 h window → finalize. The engine is a
Postgres state machine with Realtime plus polling on the phone.

**Runtime.** Next.js 16 on Vercel Pro (since today), per-minute crons for the indexer and the
Arena settler, Supabase Postgres, Alchemy RPC, Magic. No error tracking, no backups configured
on our side, no runbook.

---

## 2. Verified findings that change money or trust (fix first)

| # | Finding | Verified how | Status |
|---|---|---|---|
| 1 | `/api/polymarket/sign` was an unauthenticated builder-signature oracle returning the builder key and passphrase | read the route; curl | **Fixed and deployed today** |
| 2 | **Builder fee counted twice** in stake, odds, P&L and ROI: Polymarket's `feeUsdc` already contains the builder fee (NFL fills: remainder is exactly 3%; Liga MX exactly 5%) | live builder-trades feed, 14 of 22 fee-bearing fills checked | **Needs your go**: one-line indexer fix + backfill `pnl = pnl + builder_fee` on settled bets |
| 3 | Every authenticated request made an HTTP call to Magic's admin API just to fetch the email (feed every 30 s, arena lobby every 2 s, every sign) | read `magic-admin.ts` | **Fixed today** (email only at profile creation) |
| 4 | "tips recibidos" never renders: the only code computing it is a GET the app never calls | read `MeProvider`/`api/me` | Pending, 10 min |
| 5 | Two settlement clocks (Vercel every minute + GitHub every 5 min) and per-instance locks let indexer and Arena settle runs overlap; Arena operator nonce can race across six send paths | read `cron.yml`, `vercel.json`, `arena/server.ts` | Pending: retire the GitHub schedule, advisory lock in Postgres, cron as the only sender |
| 6 | Arena contract keys status by the client-chosen match id, not by the signed digest: a loser can block or zero a real winner's payout in edge cases (the "v3 TODO") | contract source lines 108–378 | Pending: Arena v3 (also lets us delete the publicnode log scan) |
| 7 | Data API v1 `/positions` is documented as retired on 2026-10-24 and still answers; auto-cobro and the Cobrar list depend on it | curl v1 (200) and v2 (new shape) | Pending: move to v2 before it stops |
| 8 | Signup's terms link (`/terminos`) is a 404 | file tree | Pending: one static page |
| 9 | Installed-PWA on iPhone: status bar overlaps the top bar (no top safe-area) | code path unambiguous, not device-tested | Pending: 5 lines of CSS, confirm on a phone |
| 10 | A Gamma hiccup leaves a market as "Mercado" forever: stub rows are never refetched and never settle | read indexer | Pending |

---

## 3. The lean plan (what a rebuild would look like, applied in place)

The architecture is right: Next on Vercel, Supabase, Polymarket builder program, one small
contract. A new project would keep all of it and change *how much runs per user and per
minute*. Each theme below is a bounded job; the order is by user impact.

### Theme A — First bet in one tap (UX, the funnel)
- Keep the pick through login: `next` = current page, selection stashed, sheet reopens after
  OTP or Google. Today the user lands on the board and must find the game again.
- Fold "Activar cuenta (1 vez)" into the first money action: tap Apostar → activation runs with
  the progress line → order goes out. The signatures are silent anyway.
- Auto-convert deposits: when USDC/USDC.e lands, wrap it silently (same pattern as auto-cobro)
  so the header never shows $0.00 after a deposit. Keep the manual card as fallback.
- Deposit address: verify once whether Polymarket's bridge address accepts USDC.e; if yes it
  becomes the only address users ever see and the wrap/rescue code goes away.
- `/terminos` page, iOS top safe-area, bottom sheet with internal scroll (Límite mode can push
  the close button off a small screen), `error.tsx` so a crash shows "Reintentar" instead of a
  blank app.
- Profiles open on the first window that has picks instead of a 0-0 week.

### Theme B — Record correctness (functionality)
- Fee double count: fix + backfill (needs your go).
- One definition of staked/ROI in SQL, used by lists, cards and the windows (today the view and
  the JS windows disagree).
- Settlement: multicall the payout reads, settle a market's bets in one statement, back off
  markets that never resolve, refetch stub markets.
- Data API v2 for positions; surface a failure instead of an empty list.
- Banned authors filtered from feed queries; `disputed` Arena matches counted consistently.

### Theme C — Fewer moving parts per user (lean)
- **Call Polymarket directly from the browser** for prices, book, positions and the fee rate
  (CORS confirmed open). Deletes four proxies and most Vercel invocations per user; the server
  keeps only the normalisers (board, game page, scores).
- **One bet sheet and one Boleto sheet** mounted once in the tabs layout, driven by a tiny
  store, instead of a portal inside every feed card.
- **Postgres does the aggregation:** `feed_page`, `profile_windows`, `week_table` as SQL
  functions → feed 1–2 round trips instead of 6, profile 2 instead of 12, rail cached at the
  CDN for everyone.
- **Indexer with a watermark:** request only fills after the last seen time, upsert only new
  rows, one Gamma call per 100 ids (today: whole history re-downloaded every minute).
- **One clock:** Vercel cron only, advisory lock around each run, `maxDuration` set.
- **Lazy wallet:** Magic, ethers and the Polymarket SDKs load only after login (anonymous feed
  readers pay for all of it today). Then drop `ethers` (both SDKs accept viem), `motion` (CSS can
  do the sheet and the clash), `html-to-image` (dynamic import or server OG image), the
  dev-only crypto shim and `@noble/hashes`.
- Balances in one multicall every 30 s instead of three RPC calls every 15 s on every tab.
- Shared UI primitives (one odds button, one live pill, one segmented control, one stat tile,
  one labels file) and structured outcome fields instead of regex parsing of display strings.

### Theme D — Operate it like a money app (reliability)
- Alerts to your Telegram: indexer errors, Arena operator POL balance below a floor, settle
  errors, `/api/health` for the cron.
- Supabase backups (confirm the plan; nightly dump if free tier) and a one-page runbook.
- Alchemy key restricted to patoli.bet, a separate server key.
- Verify the Arena and router source on Polygonscan.
- Arena v3: status keyed by digest, challenge window 1–2 h instead of 24 h, draws and
  cancellations settled off-chain, cron as the only operator sender. Migration = pause
  deposits, users "Regresar todo", switch addresses.

### Theme E — Distribution (growth)
- OG images for profiles, game pages and the Boleto via Next's built-in image response, so
  links in Telegram and WhatsApp show a card.
- Feed and history pagination (today a fixed window of 40).
- Search debounce and server-side game search.

---

## 4. Effort and order

| Order | Job | Size | Why first |
|---|---|---|---|
| now | Fee double count fix + backfill | S | the public record is wrong by 0.5% per bet |
| now | tips total, `/terminos`, iOS safe-area, error boundary | S | visible bugs, one evening |
| week 1 | Retire GitHub cron, advisory locks, Data API v2, stub-market refetch, Telegram alerts, backups | M | reliability of money paths |
| week 1 | Login keeps the pick; activation folded into first bet; auto-wrap | M | the first-bet funnel |
| week 2 | Direct-to-Polymarket browser calls, one sheet instance, lazy wallet SDKs, drop ethers/motion/html-to-image | M | lean: fewer invocations, smaller bundle |
| week 2 | SQL feed/windows/rail, incremental indexer, settlement multicall | M | cost and latency at hundreds of users |
| week 3 | Arena v3 + Polygonscan verification | L | trust claim, needs a short migration |
| ongoing | OG images, pagination, UI primitives, docs pass | S–M | growth and maintainability |

Everything in weeks 1–2 is invisible to users except speed. Nothing here changes a product
rule you set (va ganando at 90¢, no provisional results, no counterparties shown, Mercado hides
fees, Límite shows one Comisión line).

---

## 5. Decisions needed from you

1. **Fee fix and backfill** — go?
2. **Límite colour** — the brief says violet marks live, limit and tips; the Límite toggle,
   selected row and CTA are orange today. Keep orange or switch to violet?
3. **Profile default window** — first non-empty window (7d → 30d → all), or always Todo?
4. **Pesos** — show "≈ MXN" under balances and stakes (one small daily rate fetch) or stay USD only?
5. **Auto-activate the account right after first login** — removes a gate from the first bet,
   but creates gasless deposit wallets for people who may never fund; Polymarket pays that gas.
6. **Arena v3 scope** — digest-keyed status, 1–2 h challenge window, draws off-chain; also
   multi-stake lobbies ($0.50–$20) or keep $1?
7. **GitHub Actions cron** — retire now (Vercel has proven itself) or keep one more week?
8. **Supabase plan** — free or Pro? Free has no backups.
9. **Magic** — are Google and email logins with the same address one user or two? Check once in
   the Magic dashboard before promoting both buttons.
10. **Bitso** — which USDC does it send on Polygon (native or .e)? Decides the deposit copy and
    whether the bridge address can be the only one.

---

## 6. Still to verify (research blocked by the session limit until 7:10 pm)

- Builder program: Verified tier requirements, user-channel websocket for fills (would retire
  polling), relayer allowlist and limits, bridge asset list.
- Data API v2 field names for redeemable positions; exact retirement of v1.
- Websocket: incremental subscribe/unsubscribe (today every token-list change reconnects),
  book depth in snapshots (would retire the 3 s book poll).
- Maker fee semantics on markets that are not taker-only (`rebateRate`).
- Magic admin rate limits and whether Google + email map to one user.
- Vercel: effective `maxDuration`, Fluid Compute, function region vs Supabase region.

---

## 7. Documents to correct

- `PLAN.md` §0/§3: fee is live (0.5% taker and maker since 2026-10-24), Vercel Pro, live
  betting, "Más mercados", limit orders, tips, MLB, websocket prices all exist now.
- `patoli/CLAUDE.md`: contradicts itself on plan, clocks, Arena status and "Supabase not wired";
  one pass to a dated "Current state" block.
- `.github/workflows/cron.yml`: comment says "until Pro".

---

## 8. What is good and must not be broken

- Non-custodial end to end; secrets server-only; browser never writes to Supabase.
- Orders capped at the price on screen; net odds that match Polymarket's fee math.
- Settlement from the chain's payout vector; nothing public until Polymarket pays.
- Súbaseee/Bájeseee and tips recorded only from verified fills and receipts.
- Arena: operator can censor, never forge; replay settlement; idempotent engine transitions.
- The Boleto share loop and the es-MX tone.
