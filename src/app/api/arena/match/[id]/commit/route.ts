import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";


import { applyCommit } from "@/lib/arena/engine";
import type { Hex } from "viem";
import { fail, guard } from "@/lib/arena/http";

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
