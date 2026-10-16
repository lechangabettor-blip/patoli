import { NextRequest, NextResponse, connection } from "next/server";
import { BRIDGE_API_URL, PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";

/**
 * POST /api/polymarket/bridge-address { wallet }
 * Polymarket's bridge gives every wallet its own deposit addresses; anything
 * supported sent there (native USDC, USDT, DAI, POL…) is converted to pUSD and
 * credited to that wallet. We use it to rescue native USDC that landed in a
 * deposit wallet while the Onramp has native wrapping paused.
 */
export async function POST(req: NextRequest) {
  await connection();
  const body = (await req.json().catch(() => ({}))) as { wallet?: string };
  const wallet = body.wallet ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ error: "wallet inválida" }, { status: 400 });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isBuilderCodeValid(PATOLI_BUILDER_CODE)) headers["X-Builder-Code"] = PATOLI_BUILDER_CODE;
  const r = await fetch(`${BRIDGE_API_URL}/deposit`, { method: "POST", headers, body: JSON.stringify({ address: wallet }), cache: "no-store" });
  if (!r.ok) return NextResponse.json({ error: `bridge ${r.status}` }, { status: 502 });
  const j = (await r.json()) as { address?: { evm?: string } };
  const evm = j.address?.evm;
  if (!evm) return NextResponse.json({ error: "sin dirección evm" }, { status: 502 });
  return NextResponse.json({ evm });
}
