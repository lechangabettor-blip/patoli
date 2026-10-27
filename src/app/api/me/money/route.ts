import { NextRequest, NextResponse, connection } from "next/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { loadMoney } from "@/lib/money";

/** GET /api/me/money  (Bearer DID token) → the caller's own deposits, withdrawals and tips. Private. */
export async function GET(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const db = supabaseAdmin();
  const { data: priv } = await db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  if (!priv) return NextResponse.json({ error: "sin perfil" }, { status: 404 });
  const { data: p } = await db.from("profiles").select("wallet").eq("id", priv.profile_id as string).maybeSingle();
  if (!p?.wallet) return NextResponse.json({ rows: [] });
  try {
    const rows = await loadMoney(p.wallet as string, id.eoa ?? null, priv.profile_id as string);
    return NextResponse.json({ rows }, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "no se pudo leer la cadena" }, { status: 502 });
  }
}
