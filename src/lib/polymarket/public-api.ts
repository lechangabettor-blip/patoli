import { CLOB_API_URL, DATA_API_URL, PATOLI_BUILDER_CODE, PATOLI_BUILDER_FEE_BPS, isBuilderCodeValid } from "./constants";

/**
 * Polymarket's public endpoints, called straight from the browser. CORS is open on clob and
 * data-api (preflight for POST /prices included — verified 2026-10-29), so a quote no longer
 * goes browser → Vercel → Polymarket → back: one hop less and no function invocation per poll.
 * Our own API routes stay as the fallback for a network that blocks polymarket.com. The mappers
 * are shared with those routes so both paths return the same shapes.
 */

export type PriceMap = Record<string, { bid: number | null; ask: number | null; mid: number | null }>;

export interface BookLevel {
  price: number; // 0–1
  size: number; // shares resting
  usd: number; // price × size, rounded
}

export interface BookTop {
  asks: BookLevel[]; // cheapest first
  bids: BookLevel[]; // best first
  tickSize: number;
  minOrderSize: number;
}

/** A position as the Data API reports it for the deposit wallet (on-chain truth). */
export interface Position {
  conditionId: string;
  asset: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  redeemable: boolean;
  negativeRisk: boolean;
  endDate?: string;
  slug?: string;
}

export interface BuilderFee {
  takerBps: number;
  makerBps: number;
  /** our configured target, for display copy */
  targetBps: number;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);
const json = { "content-type": "application/json" };

/**
 * Failure memory per Polymarket host: a network that blackholes polymarket.com would otherwise
 * cost a full timeout on every poll before the proxy answers. After a direct failure the proxy
 * is used for two minutes, then the direct path is tried again.
 */
const DIRECT_BACKOFF_MS = 2 * 60_000;
const directDownUntil: Record<string, number> = {};
async function direct<T>(host: "clob" | "data", attempt: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  if (Date.now() < (directDownUntil[host] ?? 0)) return fallback();
  try {
    return await attempt();
  } catch {
    directDownUntil[host] = Date.now() + DIRECT_BACKOFF_MS;
    return fallback();
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isNaN(n) || n <= 0 || n >= 1 ? null : n;
}

/* ───────────────────────────── prices ───────────────────────────── */

type PricesResponse = Record<string, Record<string, string>>;

/** /prices answers per side; mixed sides in one call are rejected, hence two requests. */
export function pricesFrom(tokenIds: string[], asks: PricesResponse, bids: PricesResponse): PriceMap {
  const out: PriceMap = {};
  for (const id of tokenIds) {
    const a = num(asks?.[id]?.SELL);
    const b = num(bids?.[id]?.BUY);
    out[id] = { ask: a, bid: b, mid: a != null && b != null ? (a + b) / 2 : (a ?? b) };
  }
  return out;
}

export async function fetchPrices(tokenIds: string[]): Promise<PriceMap> {
  if (tokenIds.length === 0) return {};
  return direct(
    "clob",
    async () => {
      const body = (side: "SELL" | "BUY") => JSON.stringify(tokenIds.map((token_id) => ({ token_id, side })));
      const [a, b] = await Promise.all([
        fetch(`${CLOB_API_URL}/prices`, { method: "POST", headers: json, body: body("SELL"), signal: timeout(6_000) }),
        fetch(`${CLOB_API_URL}/prices`, { method: "POST", headers: json, body: body("BUY"), signal: timeout(6_000) }),
      ]);
      if (!a.ok || !b.ok) throw new Error("prices");
      return pricesFrom(tokenIds, (await a.json()) as PricesResponse, (await b.json()) as PricesResponse);
    },
    async () => {
      const r = await fetch("/api/prices", { method: "POST", headers: json, body: JSON.stringify({ tokenIds }) });
      return r.ok ? r.json() : {};
    },
  );
}

/* ───────────────────────────── order book ───────────────────────────── */

interface RawBook {
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  tick_size?: string;
  min_order_size?: string;
}

/** Top of the book: the two cheapest asks and the two best bids. */
export function bookFrom(j: RawBook): BookTop {
  const level = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size), usd: Math.round(Number(l.price) * Number(l.size)) });
  const asks = (j.asks ?? []).map(level).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price).slice(0, 2);
  const bids = (j.bids ?? []).map(level).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price).slice(0, 2);
  return { asks, bids, tickSize: Number(j.tick_size ?? 0.01), minOrderSize: Number(j.min_order_size ?? 5) };
}

export async function fetchBook(tokenId: string): Promise<BookTop> {
  return direct(
    "clob",
    async () => {
      const r = await fetch(`${CLOB_API_URL}/book?token_id=${encodeURIComponent(tokenId)}`, { signal: timeout(5_000) });
      if (!r.ok) throw new Error("book");
      return bookFrom((await r.json()) as RawBook);
    },
    async () => {
      const r = await fetch(`/api/book?tokenId=${encodeURIComponent(tokenId)}`);
      if (!r.ok) throw new Error("book");
      return r.json();
    },
  );
}

/* ───────────────────────────── builder fee ───────────────────────────── */

export async function fetchBuilderFee(): Promise<BuilderFee> {
  const fallback = async (): Promise<BuilderFee> => {
    const r = await fetch("/api/polymarket/fees");
    return r.ok ? r.json() : { takerBps: 0, makerBps: 0, targetBps: PATOLI_BUILDER_FEE_BPS };
  };
  if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) return fallback();
  return direct(
    "clob",
    async () => {
      const r = await fetch(`${CLOB_API_URL}/fees/builder-fees/${PATOLI_BUILDER_CODE}`, { signal: timeout(5_000) });
      if (!r.ok) throw new Error("fees");
      const j = (await r.json()) as { builder_taker_fee_rate_bps?: number; builder_maker_fee_rate_bps?: number };
      return { takerBps: Number(j.builder_taker_fee_rate_bps ?? 0), makerBps: Number(j.builder_maker_fee_rate_bps ?? 0), targetBps: PATOLI_BUILDER_FEE_BPS };
    },
    fallback,
  );
}

/* ───────────────────────────── positions (Data API v2) ───────────────────────────── */

/** One row of GET data-api/v2/positions (v1 /positions was retired on paper 2026-10-24). */
export interface V2Position {
  token_id: string;
  condition_id: string;
  current_size: number;
  avg_price: number;
  current_price: number;
  redeemable: boolean;
  negative_risk: boolean;
  outcome: string;
  outcome_index: number;
  end_date?: string;
  event_slug?: string;
}

export function toPosition(r: V2Position): Position {
  return {
    conditionId: r.condition_id,
    asset: r.token_id,
    outcome: r.outcome,
    outcomeIndex: Number(r.outcome_index),
    size: Number(r.current_size),
    avgPrice: Number(r.avg_price),
    curPrice: Number(r.current_price),
    redeemable: !!r.redeemable,
    negativeRisk: !!r.negative_risk,
    endDate: r.end_date,
    slug: r.event_slug,
  };
}

export const positionsUrl = (user: string) => `${DATA_API_URL}/v2/positions?${new URLSearchParams({ user, sizeThreshold: "0.01", limit: "200" })}`;

export async function fetchPositions(user: string): Promise<Position[]> {
  return direct(
    "data",
    async () => {
      const r = await fetch(positionsUrl(user), { signal: timeout(6_000) });
      if (!r.ok) throw new Error("positions");
      const j = (await r.json()) as { data?: V2Position[] };
      return (j.data ?? []).map(toPosition);
    },
    async () => {
      const r = await fetch(`/api/positions?user=${user}`);
      return r.ok ? r.json() : [];
    },
  );
}
