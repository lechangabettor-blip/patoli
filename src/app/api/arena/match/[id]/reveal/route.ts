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

import { applyReveal } from "@/lib/arena/engine";
import type { Move } from "@/lib/arena/typed-data";
import type { Hex } from "viem";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/reveal">) {
  await connection();
  try {
    const me = await guard(req);
    const { id } = await ctx.params;
    const { round, move, salt } = (await req.json()) as { round: number; move: Move; salt: Hex };
    if (![1, 2, 3].includes(Number(move)) || !/^0x[0-9a-fA-F]{64}$/.test(salt ?? "")) throw new ArenaError("datos inválidos");
    return NextResponse.json(await applyReveal(id, me, Number(round), Number(move) as Move, salt));
  } catch (e) {
    return fail(e);
  }
}
