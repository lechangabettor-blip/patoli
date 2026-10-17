import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";
import { arenaIdentity } from "@/lib/arena/server";
import { isArenaConfigured } from "@/lib/arena/typed-data";

function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: "Algo falló de nuestro lado. Intenta de nuevo." }, { status: 500 });
}
async function guard(req: NextRequest) {
  if (!isArenaConfigured()) throw new ArenaError("La arena aún no está activa", 503);
  const me = await arenaIdentity(req);
  if (!me) throw new ArenaError("sesión inválida", 401);
  return me;
}

import { applyMatchSig } from "@/lib/arena/engine";
import type { Hex } from "viem";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/sign">) {
  await connection();
  try {
    const me = await guard(req);
    const { id } = await ctx.params;
    const { sig } = (await req.json()) as { sig: Hex };
    if (!/^0x[0-9a-fA-F]+$/.test(sig ?? "")) throw new ArenaError("firma faltante");
    return NextResponse.json(await applyMatchSig(id, me, sig));
  } catch (e) {
    return fail(e);
  }
}
