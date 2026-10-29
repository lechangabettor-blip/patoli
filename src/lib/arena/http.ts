import { NextRequest, NextResponse } from "next/server";
import { ArenaError } from "./engine";
import { arenaIdentity, type ArenaIdentity } from "./server";
import { isArenaConfigured } from "./typed-data";

/** Error → HTTP. ArenaError (or any Error tagged with a `status`) carries a user-facing message; anything else is logged and masked. */
export function fail(e: unknown) {
  if (e instanceof ArenaError) return NextResponse.json({ error: e.message }, { status: e.status });
  const tagged = e instanceof Error ? (e as Error & { status?: unknown }).status : undefined;
  if (typeof tagged === "number") return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: tagged });
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
