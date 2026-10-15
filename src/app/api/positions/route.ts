import { NextRequest, NextResponse } from "next/server";
import { DATA_API_URL } from "@/lib/polymarket/constants";

/** GET /api/positions?user=0x… → the user's open Polymarket positions (public data) */
export async function GET(request: NextRequest) {
  const user = request.nextUrl.searchParams.get("user");
  if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) {
    return NextResponse.json({ error: "user inválido" }, { status: 400 });
  }
  const params = new URLSearchParams({ user, sizeThreshold: "0.01", limit: "200" });
  const res = await fetch(`${DATA_API_URL}/positions?${params}`, { cache: "no-store" });
  if (!res.ok) return NextResponse.json({ error: "data api" }, { status: 502 });
  return NextResponse.json(await res.json(), { headers: { "Cache-Control": "no-store" } });
}
