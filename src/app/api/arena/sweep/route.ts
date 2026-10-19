import { NextRequest, NextResponse, connection } from "next/server";
import { ArenaError } from "@/lib/arena/engine";
import { arenaIdentity, arenaBalance, arenaLimits, forwarderOf, sendSweep, waitForTx } from "@/lib/arena/server";
import { isArenaConfigured, isRouterConfigured, fromUnits } from "@/lib/arena/typed-data";
import { erc20Balance } from "@/lib/polymarket/v2";
import { PUSD_ADDRESS } from "@/lib/polymarket/constants";

function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: "Algo falló de nuestro lado. Intenta de nuevo." }, { status: 500 });
}

// one sweep in flight per user (a tapping user must not cost the operator N transactions)
const inflight = new Set<string>();

/** POST → sweep the caller's forwarder into the Arena. Idempotent; no-op when empty or below the minimum stake. */
export async function POST(req: NextRequest) {
  await connection();
  try {
    if (!isArenaConfigured() || !isRouterConfigured()) throw new ArenaError("La arena aún no está activa", 503);
    const me = await arenaIdentity(req);
    if (!me) throw new ArenaError("sesión inválida", 401);
    const fwd = await forwarderOf(me.eoa);
    const [waiting, limits] = await Promise.all([erc20Balance(PUSD_ADDRESS, fwd), arenaLimits()]);
    if (waiting === 0n) return NextResponse.json({ swept: 0, balance: fromUnits(await arenaBalance(me.eoa)) });
    if (waiting < limits.min) throw new ArenaError(`Mínimo $${fromUnits(limits.min)} para acreditar.`, 400);
    if (inflight.has(me.eoa)) throw new ArenaError("Ya se está acreditando. Espera unos segundos.", 429);
    inflight.add(me.eoa);
    try {
      const tx = await sendSweep(me.eoa);
      const r = await waitForTx(tx);
      if (r.status !== "success") throw new ArenaError("No se pudo acreditar. Tus fondos siguen en tu buzón; intenta de nuevo.", 502);
      return NextResponse.json({ swept: fromUnits(waiting), tx, balance: fromUnits(await arenaBalance(me.eoa)) });
    } finally {
      inflight.delete(me.eoa);
    }
  } catch (e) {
    return fail(e);
  }
}
