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

import { applyCommit } from "@/lib/arena/engine";
import type { Hex } from "viem";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/commit">) {
  await connection();
  try {
    const me = await guard(req);
    const { id } = await ctx.params;
    const { round, hash, sig } = (await req.json()) as { round: number; hash: Hex; sig: Hex };
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "") || !/^0x[0-9a-fA-F]+$/.test(sig ?? "")) throw new ArenaError("datos inválidos");
    return NextResponse.json(await applyCommit(id, me, Number(round), hash, sig));
  } catch (e) {
    return fail(e);
  }
}
