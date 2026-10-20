import { NextRequest, NextResponse, connection } from "next/server";
import { proposeRematch } from "@/lib/arena/engine";
import { fail, guard } from "@/lib/arena/http";

/** POST → "Doble o nada": opens/accepts the 10s rematch window; creates the next match when both are in. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/arena/match/[id]/rematch">) {
  await connection();
  try {
    const me = await guard(req);
    const { id } = await ctx.params;
    const match = await proposeRematch(id, me);
    return NextResponse.json({ match });
  } catch (e) {
    return fail(e);
  }
}
