import { NextRequest, NextResponse } from "next/server";
import { fetchPricesDirect } from "@/lib/polymarket/public-api";

/**
 * POST /api/prices  { tokenIds: string[] } → { [tokenId]: { bid, ask, mid } } from the CLOB.
 * Fallback path: the browser asks clob.polymarket.com directly and comes here only when that fails.
 */
export async function POST(request: NextRequest) {
  let tokenIds: string[] = [];
  try {
    const body = await request.json();
    tokenIds = Array.isArray(body?.tokenIds) ? body.tokenIds.slice(0, 250) : [];
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (tokenIds.length === 0) return NextResponse.json({});
  try {
    return NextResponse.json(await fetchPricesDirect(tokenIds), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({}, { headers: { "Cache-Control": "no-store" } });
  }
}
