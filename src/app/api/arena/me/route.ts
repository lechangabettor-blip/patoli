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

import { arenaBalance, arenaNonce, arenaPendingWithdraw, forwarderOf } from "@/lib/arena/server";
import { isRouterConfigured } from "@/lib/arena/typed-data";
import { erc20Balance } from "@/lib/polymarket/v2";
import { PUSD_ADDRESS } from "@/lib/polymarket/constants";
import { openMatchFor } from "@/lib/arena/engine";
import { fromUnits } from "@/lib/arena/typed-data";

/** GET → arena balance, pending withdraw, nonce, open match */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    const [bal, pending, nonce, open, waiting] = await Promise.all([
      arenaBalance(me.eoa),
      arenaPendingWithdraw(me.eoa),
      arenaNonce(me.eoa),
      openMatchFor(me.profileId),
      isRouterConfigured() ? forwarderOf(me.eoa).then((f) => erc20Balance(PUSD_ADDRESS, f)).catch(() => 0n) : Promise.resolve(0n),
    ]);
    return NextResponse.json({
      balance: fromUnits(bal),
      waiting: fromUnits(waiting), // pUSD sitting in the forwarder, not yet swept
      pending: pending.amount > 0n ? { amount: fromUnits(pending.amount), to: pending.to, readyAt: Number(pending.readyAt) } : null,
      nonce: nonce.toString(),
      matchId: open?.id ?? null,
      matchStatus: open?.status ?? null,
    });
  } catch (e) {
    return fail(e);
  }
}
