import { NextRequest, NextResponse } from "next/server";
import { ArenaError } from "./engine";
import { arenaIdentity, type ArenaIdentity } from "./server";
import { isArenaConfigured } from "./typed-data";

/** Error → HTTP. ArenaError carries its status + a user-facing message; anything else is logged and masked. */
export function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[arena]", e);
  return NextResponse.json({ error: "Algo falló de nuestro lado. Intenta de nuevo." }, { status: 500 });
}

/** Arena configured + valid session, or throws an ArenaError the caller turns into a response. */
export async function guard(req: NextRequest): Promise<ArenaIdentity> {
  if (!isArenaConfigured()) throw new ArenaError("La arena aún no está activa", 503);
  const me = await arenaIdentity(req);
  if (!me) throw new ArenaError("sesión inválida", 401);
  return me;
}
