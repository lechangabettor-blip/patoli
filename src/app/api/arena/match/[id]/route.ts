import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";

function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: "Algo falló de nuestro lado. Intenta de nuevo." }, { status: 500 });
}

import { loadMatch } from "@/lib/arena/engine";

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
