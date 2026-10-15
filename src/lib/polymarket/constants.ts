// Polymarket endpoints and on-chain constants (Polygon mainnet).
// Verified against Polymarket's magic-safe-builder-example (Oct 2026).

export const POLYGON_CHAIN_ID = 137;

export const CLOB_API_URL = "https://clob.polymarket.com";
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";
export const DATA_API_URL = "https://data-api.polymarket.com";
export const RELAYER_URL = "https://relayer-v2.polymarket.com/";
export const GEOBLOCK_API_URL = "https://polymarket.com/api/geoblock";

// Magic's iframe enforces a CSP allowlist of RPC hosts (alchemy, infura,
// thirdweb, …). polygon-rpc.com is on it but returns 401 since Oct 2026;
// thirdweb's keyless endpoint is on it and works. Use an Alchemy key in prod.
export const POLYGON_RPC_URL =
  process.env.NEXT_PUBLIC_POLYGON_RPC_URL || "https://polygon.rpc.thirdweb.com";

/** Our own route that signs builder-attribution headers server-side. */
export const REMOTE_SIGNING_URL = () =>
  typeof window !== "undefined"
    ? `${window.location.origin}/api/polymarket/sign`
    : "/api/polymarket/sign";

// ── Tokens / contracts (Polygon mainnet) ─────────────────────────────
// V1 (legacy Safe/Proxy era): collateral USDC.e, exchanges below.
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
export const USDC_E_DECIMALS = 6;
export const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045" as const;
export const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const;
export const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;

// V2 (CLOB V2, deposit wallets, since 2026): collateral is pUSD, a 1:1 wrapper
// of USDC.e minted by the CollateralOnramp. Addresses from docs.polymarket.com
// (concepts/pusd, trading/deposit-wallets) and ArbClaude's working setup.
export const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
export const PUSD_DECIMALS = 6;
export const COLLATERAL_ONRAMP_ADDRESS = "0x93070a847efEf7F70739046A929D47a521F5B8ee" as const;
export const COLLATERAL_OFFRAMP_ADDRESS = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854" as const;
export const V2_PROTOCOL_EXCHANGE_ADDRESS = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa" as const;
export const V2_STANDARD_EXCHANGE_ADDRESS = "0xE111180000d2663C0091e4f400237545B87B996B" as const;
export const V2_NEG_RISK_EXCHANGE_ADDRESS = "0xe2222d279d744050d28e00520010520000310F59" as const;
export const V2_POSITION_MANAGER_ADDRESS = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF" as const;

// Fees (see docs: sports taker fee rate 0.05 since Jul-2026; builder fee is ours)
export const POLYMARKET_SPORTS_FEE_RATE = 0.05;
/** Our builder fee in basis points (max allowed by the Builder Program is 100). */
export const PATOLI_BUILDER_FEE_BPS = Number(process.env.NEXT_PUBLIC_PATOLI_FEE_BPS ?? 100);

/**
 * Builder code: 32-byte hex from polymarket.com → Settings → Builders. It is
 * embedded in every signed order (public by nature) and is what credits
 * volume + fees to Patoli. Empty = orders are not attributed.
 */
export const PATOLI_BUILDER_CODE = (process.env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE ?? "").trim();
export const isBuilderCodeValid = (code: string) => /^0x[0-9a-fA-F]{64}$/.test(code);

export const POLYMARKET_PROFILE_URL = (address: string) => `https://polymarket.com/${address}`;
export const POLYGONSCAN_TX_URL = (hash: string) => `https://polygonscan.com/tx/${hash}`;
