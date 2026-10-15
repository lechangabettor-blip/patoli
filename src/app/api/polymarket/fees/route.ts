import { NextResponse, connection } from "next/server";
import { CLOB_API_URL, PATOLI_BUILDER_CODE, PATOLI_BUILDER_FEE_BPS, isBuilderCodeValid } from "@/lib/polymarket/constants";

/**
 * GET /api/polymarket/fees → the builder fee Polymarket will actually charge
 * on Patoli orders right now. Until the builder account has a fee rate
 * configured (Verified tier), Polymarket charges 0 even if we'd like 1%, so
 * the bet sheet must show the live number, not our target.
 */
let cache: { at: number; body: FeeInfo } | null = null;
const TTL = 5 * 60_000;

interface FeeInfo {
  takerBps: number;
  makerBps: number;
  /** our configured target, for display copy */
  targetBps: number;
  source: "polymarket" | "fallback";
}

export async function GET() {
  await connection(); // request-time: reads env + live Polymarket data, never prerendered
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json(cache.body);
  let body: FeeInfo = { takerBps: 0, makerBps: 0, targetBps: PATOLI_BUILDER_FEE_BPS, source: "fallback" };
  if (isBuilderCodeValid(PATOLI_BUILDER_CODE)) {
    try {
      const r = await fetch(`${CLOB_API_URL}/fees/builder-fees/${PATOLI_BUILDER_CODE}`, { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { builder_taker_fee_rate_bps?: number; builder_maker_fee_rate_bps?: number };
        body = {
          takerBps: Number(j.builder_taker_fee_rate_bps ?? 0),
          makerBps: Number(j.builder_maker_fee_rate_bps ?? 0),
          targetBps: PATOLI_BUILDER_FEE_BPS,
          source: "polymarket",
        };
      }
    } catch (e) {
      console.warn("builder fees fetch failed", e);
    }
  }
  cache = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { "Cache-Control": "public, s-maxage=300" } });
}
