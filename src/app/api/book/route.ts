import { NextRequest, NextResponse, connection } from "next/server";
import { CLOB_API_URL } from "@/lib/polymarket/constants";
import { bookFrom } from "@/lib/polymarket/public-api";

/**
 * GET /api/book?tokenId=… → the top of Polymarket's order book for one outcome token (two
 * cheapest asks, two best bids). Fallback path for the Límite view: the browser reads the book
 * from clob.polymarket.com directly and comes here only when that fails.
 */
export async function GET(req: NextRequest) {
  await connection();
  const tokenId = req.nextUrl.searchParams.get("tokenId") ?? "";
  if (!/^\d{10,100}$/.test(tokenId)) return NextResponse.json({ error: "tokenId inválido" }, { status: 400 });
  const r = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!r.ok) return NextResponse.json({ error: `book ${r.status}` }, { status: 502 });
  return NextResponse.json(bookFrom(await r.json()), { headers: { "cache-control": "no-store" } });
}
