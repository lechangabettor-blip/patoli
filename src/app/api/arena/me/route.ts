import { NextRequest, NextResponse, connection } from "next/server";


import { arenaBalance, arenaNonce, arenaPendingWithdraw, forwarderOf } from "@/lib/arena/server";
import { unsettledOwed } from "@/lib/arena/engine";
import { isRouterConfigured } from "@/lib/arena/typed-data";
import { erc20Balance } from "@/lib/polymarket/v2";
import { PUSD_ADDRESS } from "@/lib/polymarket/constants";
import { openMatchFor } from "@/lib/arena/engine";
import { fromUnits } from "@/lib/arena/typed-data";
import { fail, guard } from "@/lib/arena/http";

/** GET → arena balance, pending withdraw, nonce, open match */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const me = await guard(req);
    const [bal, pending, nonce, open, waiting, owed] = await Promise.all([
      arenaBalance(me.eoa),
      arenaPendingWithdraw(me.eoa),
      arenaNonce(me.eoa),
      openMatchFor(me.profileId),
      isRouterConfigured() ? forwarderOf(me.eoa).then((f) => erc20Balance(PUSD_ADDRESS, f)).catch(() => 0n) : Promise.resolve(0n),
      unsettledOwed(me.eoa),
    ]);
    return NextResponse.json({
      balance: fromUnits(bal),
      free: fromUnits(bal - owed > 0n ? bal - owed : 0n), // what can be withdrawn / staked right now
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
