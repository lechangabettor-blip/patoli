import { NextRequest, NextResponse, connection } from "next/server";


import { loadMatch } from "@/lib/arena/engine";
import { fail } from "@/lib/arena/http";

/** GET → public match state (no secrets live in these tables) */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const loaded = await loadMatch(id);
    if (!loaded) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(loaded, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}
