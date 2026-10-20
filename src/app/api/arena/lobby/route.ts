import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";


import { joinLobby, leaveLobby, lobbyStatus, openMatchFor } from "@/lib/arena/engine";
import { LOBBY_STAKE_USD } from "@/lib/arena/typed-data";
import { fail, guard } from "@/lib/arena/http";

/** POST join (body {stake?}) · DELETE leave · GET status */
export async function POST(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    const body = (await req.json().catch(() => ({}))) as { stake?: number };
    const stake = Number(body.stake ?? LOBBY_STAKE_USD);
    if (stake !== LOBBY_STAKE_USD) throw new ArenaError("Por ahora solo hay lobby de $" + LOBBY_STAKE_USD);
    const r = await joinLobby(me, stake);
    return NextResponse.json(r);
  } catch (e) {
    return fail(e);
  }
}
export async function DELETE(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    await leaveLobby(me.profileId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
export async function GET(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    const [status, open] = await Promise.all([lobbyStatus(me.profileId), openMatchFor(me.profileId)]);
    return NextResponse.json({ ...status, matchId: open?.id ?? null });
  } catch (e) {
    return fail(e);
  }
}
