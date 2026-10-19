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

import { arenaBalance, arenaNonce, sendWithdrawWithSig, verifyWithdrawSig, waitForTx } from "@/lib/arena/server";
import { leaveLobby, lobbyStatus, openMatchFor, unsettledOwed } from "@/lib/arena/engine";
import { toUnits } from "@/lib/arena/typed-data";
import type { Hex } from "viem";

/** POST { amount (USD), deadline (unix s), sig } → relays withdrawWithSig to the player's deposit wallet. */
export async function POST(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    const { amount, deadline, sig } = (await req.json()) as { amount: number; deadline: number; sig: Hex };
    const units = toUnits(Number(amount));
    if (units <= 0n) throw new ArenaError("Monto inválido");
    if (await openMatchFor(me.profileId)) throw new ArenaError("Termina tu partida antes de retirar", 409);
    if ((await lobbyStatus(me.profileId)).queued) {
      await leaveLobby(me.profileId); // can't be matched while withdrawing
      throw new ArenaError("Te sacamos del lobby. Intenta retirar de nuevo.", 409);
    }
    const [bal, nonce, owed] = await Promise.all([arenaBalance(me.eoa), arenaNonce(me.eoa), unsettledOwed(me.eoa)]);
    if (bal - owed < units) throw new ArenaError(owed > 0n ? "Parte de tu saldo está comprometido en una partida por liquidar." : "Saldo insuficiente en la arena");
    const msg = { player: me.eoa, to: me.wallet, amount: units, nonce, deadline: BigInt(deadline) };
    if (!(await verifyWithdrawSig(msg, sig))) throw new ArenaError("Firma inválida");
    const tx = await sendWithdrawWithSig(me.eoa, me.wallet, units, BigInt(deadline), sig);
    const receipt = await waitForTx(tx);
    if (receipt.status !== "success") throw new ArenaError("La transacción falló", 502);
    return NextResponse.json({ tx });
  } catch (e) {
    return fail(e);
  }
}
