import { NextRequest, NextResponse } from "next/server";
import { CLOB_API_URL } from "@/lib/polymarket/constants";
import { pricesFrom } from "@/lib/polymarket/public-api";

/**
 * POST /api/prices  { tokenIds: string[] } → { [tokenId]: { bid, ask, mid } } from the CLOB.
 * Fallback path: the browser asks clob.polymarket.com directly and comes here only when that fails.
 */
export async function POST(request: NextRequest) {
  let tokenIds: string[] = [];
  try {
    const body = await request.json();
    tokenIds = Array.isArray(body?.tokenIds) ? body.tokenIds.slice(0, 200) : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (tokenIds.length === 0) return NextResponse.json({});

  const side = (s: "SELL" | "BUY") =>
    fetch(`${CLOB_API_URL}/prices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenIds.map((token_id) => ({ token_id, side: s }))),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    }).then((r) => (r.ok ? r.json() : {}));
  const [asks, bids] = await Promise.all([side("SELL"), side("BUY")]);
  return NextResponse.json(pricesFrom(tokenIds, asks, bids), { headers: { "Cache-Control": "no-store" } });
}
