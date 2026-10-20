import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";


import { applyReveal } from "@/lib/arena/engine";
import type { Move } from "@/lib/arena/typed-data";
import type { Hex } from "viem";
import { fail, guard } from "@/lib/arena/http";

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
