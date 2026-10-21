# Patoli

Social betting for the banda: sports bets routed to Polymarket, a public verifiable record,
and player-vs-player piedra·papel·tijera settled on Polygon with no house and no rake.

Mobile-first Next.js 16 PWA. Full context for working on this repo lives in `CLAUDE.md`.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in the keys (see .env.example comments)
npm run dev                  # http://localhost:3000
```

Phone testing on the LAN (production build, all interfaces):

```bash
npm run build && npm run start -- --port 3000 -H 0.0.0.0
```

Do not run a local server against the production database while patoli.bet is live: it becomes a second
settler for the Arena. Use the deployed site for real matches.

## Layout

| Path | What |
|---|---|
| `src/app/(tabs)` | the five tabs: Inicio · Deportes · Batalla · Buscar · Perfil |
| `src/app/api` | route handlers (games/prices, social, indexer, arena, polymarket helpers) |
| `src/lib/polymarket` | Gamma/CLOB normalizers, V2 deposit-wallet plumbing, fee math |
| `src/lib/arena` | PvP engine (DB state machine), chain calls, EIP-712 types |
| `src/lib/indexer` | builder-trades → `bets`, market metadata, settlement |
| `src/providers`, `src/hooks` | wallet (Magic), trading session, profile, data hooks |
| `supabase/migrations` | Postgres schema, applied in order via the SQL editor |
| `arena/` | Hardhat project: `PatoliArena.sol`, `ArenaDepositRouter.sol`, tests, deploy scripts |

## Contracts (Polygon)

Addresses and owners are recorded in `arena/deployments/polygon.json`.

```bash
cd arena && npm install && npm test
```
