import { NextRequest, NextResponse } from "next/server";
import { positionsUrl, toPosition, type V2Position } from "@/lib/polymarket/public-api";

/**
 * GET /api/positions?user=0x… → the user's Polymarket positions (public data), Data API v2.
 * Fallback path only: the browser calls data-api.polymarket.com directly (CORS is open) and
 * comes here when that fails. v1 /positions was retired on paper on 2026-10-24.
 */
export async function GET(request: NextRequest) {
  const user = request.nextUrl.searchParams.get("user");
  if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
    return NextResponse.json({ error: "user inválido" }, { status: 400 });
  }
  const res = await fetch(positionsUrl(user), { cache: "no-store", signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res?.ok) return NextResponse.json({ error: "data api" }, { status: 502 });
  const j = (await res.json()) as { data?: V2Position[] };
  return NextResponse.json((j.data ?? []).map(toPosition), { headers: { "Cache-Control": "no-store" } });
}
