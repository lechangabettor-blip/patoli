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

// Tokens / contracts
export const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
export const USDC_E_DECIMALS = 6;
export const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045" as const;
export const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const;
export const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296" as const;

// Fees (see docs: sports taker fee rate 0.05 since Jul-2026; builder fee is ours)
export const POLYMARKET_SPORTS_FEE_RATE = 0.05;
/** Our builder fee in basis points (max allowed by the Builder Program is 100). */
export const PATOLI_BUILDER_FEE_BPS = Number(process.env.NEXT_PUBLIC_PATOLI_FEE_BPS ?? 100);

export const POLYMARKET_PROFILE_URL = (address: string) => `https://polymarket.com/${address}`;
export const POLYGONSCAN_TX_URL = (hash: string) => `https://polygonscan.com/tx/${hash}`;
