import { NextRequest, NextResponse } from "next/server";
import { CLOB_API_URL } from "@/lib/polymarket/constants";

/**
 * POST /api/prices  { tokenIds: string[] }
 * → { [tokenId]: { bid, ask, mid } }  from the CLOB order book (no auth needed).
 * Proxied server-side so the browser makes one request instead of 2×N.
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

  const ask = fetch(`${CLOB_API_URL}/prices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id, side: "SELL" }))),
    cache: "no-store",
  }).then((r) => (r.ok ? r.json() : {}));
  const bid = fetch(`${CLOB_API_URL}/prices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tokenIds.map((token_id) => ({ token_id, side: "BUY" }))),
    cache: "no-store",
  }).then((r) => (r.ok ? r.json() : {}));

  const [asks, bids] = (await Promise.all([ask, bid])) as [Record<string, Record<string, string>>, Record<string, Record<string, string>>];

  const out: Record<string, { bid: number | null; ask: number | null; mid: number | null }> = {};
  for (const id of tokenIds) {
    const a = num(asks?.[id]?.SELL);
    const b = num(bids?.[id]?.BUY);
    out[id] = { ask: a, bid: b, mid: a != null && b != null ? (a + b) / 2 : (a ?? b) };
  }
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isNaN(n) || n <= 0 || n >= 1 ? null : n;
}
