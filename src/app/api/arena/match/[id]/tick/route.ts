import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";
import { arenaIdentity } from "@/lib/arena/server";
import { isArenaConfigured } from "@/lib/arena/typed-data";

function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
}
async function guard(req: NextRequest) {
  if (!isArenaConfigured()) throw new ArenaError("La arena aún no está activa", 503);
  const me = await arenaIdentity(req);
  if (!me) throw new ArenaError("sesión inválida", 401);
  return me;
}

import { tick } from "@/lib/arena/engine";

/** Clients call this when a timer hits zero; the server applies the timeout rule. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/tick">) {
  await connection();
  try {
    await guard(req);
    const { id } = await ctx.params;
    return NextResponse.json(await tick(id));
  } catch (e) {
    return fail(e);
  }
}
