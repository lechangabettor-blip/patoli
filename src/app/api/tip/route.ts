import { NextRequest, NextResponse, connection } from "next/server";
import { createPublicClient, erc20Abi, formatUnits, http, parseEventLogs } from "viem";
import { polygon } from "viem/chains";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { isMagicAdminConfigured } from "@/lib/magic-admin";
import { resolveViewer } from "@/lib/social";
import { POLYGON_RPC_URL, PUSD_ADDRESS, PUSD_DECIMALS, TIP_MAX_USD } from "@/lib/polymarket/constants";

const TX = /^0x[0-9a-f]{64}$/;
const client = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });

/**
 * POST /api/tip { txHash, to: handle }  (Bearer DID token) → { amount }
 * The client's word counts for nothing: we read the receipt and require a pUSD Transfer from the
 * viewer's deposit wallet to the recipient's deposit wallet, ≤ TIP_MAX_USD. One row per tx.
 */
export async function POST(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const viewerId = await resolveViewer(req);
  if (!viewerId) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { txHash?: string; to?: string };
  const txHash = (body.txHash ?? "").trim().toLowerCase();
  const handle = (body.to ?? "").trim().toLowerCase();
  if (!TX.test(txHash) || !handle) return NextResponse.json({ error: "datos inválidos" }, { status: 400 });
  const db = supabaseAdmin();

  const [{ data: from }, { data: to }] = await Promise.all([
    db.from("profiles").select("id, wallet").eq("id", viewerId).maybeSingle(),
    db.from("profiles").select("id, wallet").eq("handle", handle).eq("is_banned", false).maybeSingle(),
  ]);
  if (!from?.wallet || !to?.wallet) return NextResponse.json({ error: "perfil no encontrado" }, { status: 404 });
  if (from.id === to.id) return NextResponse.json({ error: "no te puedes dar tip a ti mismo" }, { status: 400 });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return NextResponse.json({ error: "transacción aún no visible", pending: true }, { status: 202 });
  }
  if (receipt.status !== "success") return NextResponse.json({ error: "la transacción falló" }, { status: 409 });
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === PUSD_ADDRESS.toLowerCase() && l.args.from.toLowerCase() === (from.wallet as string).toLowerCase() && l.args.to.toLowerCase() === (to.wallet as string).toLowerCase(),
  );
  const raw = transfers.reduce((s, l) => s + l.args.value, 0n);
  if (raw <= 0n) return NextResponse.json({ error: "esa transacción no es un tip entre estas cuentas" }, { status: 409 });
  const amount = Number(formatUnits(raw, PUSD_DECIMALS));
  if (amount > TIP_MAX_USD) return NextResponse.json({ error: `excede el máximo de $${TIP_MAX_USD}` }, { status: 409 });

  const { error } = await db.from("tips").upsert({ tx_hash: txHash, from_profile: from.id, to_profile: to.id, amount }, { onConflict: "tx_hash", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: "no se pudo guardar" }, { status: 500 });
  return NextResponse.json({ amount });
}
