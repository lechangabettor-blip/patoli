import { NextRequest, NextResponse, connection } from "next/server";


import { tick } from "@/lib/arena/engine";
import { fail, guard } from "@/lib/arena/http";

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
