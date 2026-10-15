import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";

/** POST /api/follow { handle, follow: boolean }  (Bearer DID token) */
export async function POST(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { handle?: string; follow?: boolean };
  const handle = (body.handle ?? "").toLowerCase();
  if (!handle) return NextResponse.json({ error: "handle requerido" }, { status: 400 });
  const db = supabaseAdmin();
  const [{ data: me }, { data: target }] = await Promise.all([
    db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle(),
    db.from("profiles").select("id").eq("handle", handle).maybeSingle(),
  ]);
  if (!me) return NextResponse.json({ error: "crea tu perfil primero" }, { status: 404 });
  if (!target) return NextResponse.json({ error: "usuario no existe" }, { status: 404 });
  if (me.profile_id === target.id) return NextResponse.json({ error: "no puedes seguirte" }, { status: 400 });
  if (body.follow === false) {
    await db.from("follows").delete().eq("follower_id", me.profile_id).eq("followee_id", target.id);
  } else {
    await db.from("follows").upsert({ follower_id: me.profile_id, followee_id: target.id }, { onConflict: "follower_id,followee_id", ignoreDuplicates: true });
  }
  return NextResponse.json({ ok: true, following: body.follow !== false });
}
