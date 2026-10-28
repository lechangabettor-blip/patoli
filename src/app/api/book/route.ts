import { NextRequest, NextResponse, connection } from "next/server";
import { CLOB_API_URL } from "@/lib/polymarket/constants";

/**
 * GET /api/book?tokenId=…  → the top of Polymarket's order book for one outcome token:
 * the two cheapest asks and the two best bids, each with price (0–1) and USD resting.
 * Powers the Límite view of the bet sheet; polled every few seconds while it is open.
 */
export async function GET(req: NextRequest) {
  await connection();
  const tokenId = req.nextUrl.searchParams.get("tokenId") ?? "";
  if (!/^\d{10,100}$/.test(tokenId)) return NextResponse.json({ error: "tokenId inválido" }, { status: 400 });
  const r = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!r.ok) return NextResponse.json({ error: `book ${r.status}` }, { status: 502 });
  const j = (await r.json()) as { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[]; tick_size?: string; min_order_size?: string };
  const level = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size), usd: Math.round(Number(l.price) * Number(l.size)) });
  const asks = (j.asks ?? []).map(level).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price).slice(0, 2);
  const bids = (j.bids ?? []).map(level).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price).slice(0, 2);
  return NextResponse.json({ asks, bids, tickSize: Number(j.tick_size ?? 0.01), minOrderSize: Number(j.min_order_size ?? 5) }, { headers: { "cache-control": "no-store" } });
}
