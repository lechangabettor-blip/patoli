import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";


import { applyMatchSig } from "@/lib/arena/engine";
import type { Hex } from "viem";
import { fail, guard } from "@/lib/arena/http";

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
