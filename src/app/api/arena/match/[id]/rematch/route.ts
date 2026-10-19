import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError, proposeRematch } from "@/lib/arena/engine";
import { arenaIdentity } from "@/lib/arena/server";
import { isArenaConfigured } from "@/lib/arena/typed-data";

function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: "Algo falló de nuestro lado. Intenta de nuevo." }, { status: 500 });
}

/** POST → "Doble o nada": opens/accepts the 10s rematch window; creates the next match when both are in. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/rematch">) {
  await connection();
  try {
    if (!isArenaConfigured()) throw new ArenaError("La arena aún no está activa", 503);
    const me = await arenaIdentity(req);
    if (!me) throw new ArenaError("sesión inválida", 401);
    const { id } = await ctx.params;
    const match = await proposeRematch(id, me);
    return NextResponse.json({ match });
  } catch (e) {
    return fail(e);
  }
}
