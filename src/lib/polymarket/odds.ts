import { PATOLI_BUILDER_FEE_BPS, POLYMARKET_SPORTS_FEE_RATE } from "./constants";

/**
 * Price math for the bet slip.
 *
 * Polymarket shares pay $1 if the outcome happens. A share bought at price p
 * costs p plus fees:
 *   - Polymarket taker fee  = rate · (p · (1 − p))^exponent   per share — rate and exponent
 *     are set per market by Polymarket (Gamma `feeSchedule`); exponent is 1 today
 *   - Patoli builder fee    = p · bps / 10 000          per share
 * Decimal odds are 1 / (effective cost per share).
 */

export interface OddsBreakdown {
  /** Raw market price (0–1) */
  price: number;
  /** Gross decimal odds at market price (1/p) */
  marketOdds: number;
  /** Polymarket taker fee per share, in USDC */
  polymarketFee: number;
  /** Patoli fee per share, in USDC */
  patoliFee: number;
  /** All-in cost per share */
  costPerShare: number;
  /** Decimal odds the user actually gets, after both fees */
  netOdds: number;
  /** Fee as % of stake (both fees) */
  totalFeePct: number;
}

export interface FeeSchedule {
  rate: number;
  exponent: number;
}

export const DEFAULT_FEE: FeeSchedule = { rate: POLYMARKET_SPORTS_FEE_RATE, exponent: 1 };

export function breakdown(
  price: number,
  fee: FeeSchedule = DEFAULT_FEE,
  builderBps = PATOLI_BUILDER_FEE_BPS,
): OddsBreakdown {
  const p = clamp(price, 0.001, 0.999);
  const polymarketFee = fee.rate * Math.pow(p * (1 - p), fee.exponent || 1);
  const patoliFee = (p * builderBps) / 10_000;
  const costPerShare = p + polymarketFee + patoliFee;
  return {
    price: p,
    marketOdds: 1 / p,
    polymarketFee,
    patoliFee,
    costPerShare,
    netOdds: 1 / costPerShare,
    totalFeePct: ((polymarketFee + patoliFee) / p) * 100,
  };
}

export function formatOdds(decimal: number): string {
  if (!isFinite(decimal) || decimal <= 1) return "—";
  return decimal >= 100 ? decimal.toFixed(0) : decimal.toFixed(2);
}

export function formatUsd(n: number, digits = 2): string {
  return n.toLocaleString("es-MX", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
