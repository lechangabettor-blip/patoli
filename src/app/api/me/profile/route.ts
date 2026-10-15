import { NextRequest, NextResponse, connection } from "next/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { loadProfile } from "@/lib/social";

/** PATCH /api/me/profile { handle?, displayName?, bio?, avatar? }  (Bearer DID token) */

const RESERVED = new Set(["patoli", "patolli", "admin", "soporte", "support", "lechanga", "paulovski", "banda", "oficial", "official"]);
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const COOLDOWN_MS = 30 * 24 * 3600_000;

export async function PATCH(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { handle?: string; displayName?: string; bio?: string; avatar?: string };
  const db = supabaseAdmin();
  const { data: priv } = await db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  if (!priv) return NextResponse.json({ error: "crea tu perfil primero" }, { status: 404 });
  const profileId = priv.profile_id as string;

  const { data: current } = await db.from("profiles").select("handle, handle_changed_at").eq("id", profileId).maybeSingle();
  const patch: Record<string, string> = {};
  let releasedHandle: string | null = null;
  if (body.handle !== undefined && body.handle.trim().toLowerCase() !== current?.handle) {
    const h = body.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(h)) return NextResponse.json({ error: "El usuario debe tener 3 a 20 letras, números o guion bajo." }, { status: 400 });
    if (RESERVED.has(h)) return NextResponse.json({ error: "Ese nombre está reservado." }, { status: 400 });
    // One change per 30 days (stops handle-swapping games)
    const changedAt = current?.handle_changed_at ? new Date(current.handle_changed_at as string).getTime() : 0;
    if (Date.now() - changedAt < COOLDOWN_MS) {
      return NextResponse.json({ error: "Solo puedes cambiar tu usuario una vez cada 30 días." }, { status: 429 });
    }
    const { data: taken } = await db.from("profiles").select("id").eq("handle", h).neq("id", profileId).maybeSingle();
    if (taken) return NextResponse.json({ error: "Ese usuario ya existe." }, { status: 409 });
    // Released names stay on hold 30 days so a dropped handle can't be grabbed to impersonate
    const { data: held } = await db.from("handle_history").select("profile_id, released_at").eq("handle", h).maybeSingle();
    if (held && held.profile_id !== profileId && Date.now() - new Date(held.released_at as string).getTime() < COOLDOWN_MS) {
      return NextResponse.json({ error: "Ese usuario no está disponible todavía." }, { status: 409 });
    }
    patch.handle = h;
    patch.handle_changed_at = new Date().toISOString();
    releasedHandle = current?.handle ?? null;
  }
  if (body.displayName !== undefined) {
    const d = body.displayName.trim().slice(0, 30);
    if (d.length < 1) return NextResponse.json({ error: "Pon un nombre." }, { status: 400 });
    patch.display_name = d;
  }
  if (body.bio !== undefined) patch.bio = body.bio.trim().slice(0, 140);
  if (body.avatar !== undefined) {
    const a = body.avatar.trim();
    // one emoji (or a short seed string); no URLs for now
    if (a.length > 8 || /https?:/i.test(a)) return NextResponse.json({ error: "Avatar inválido." }, { status: 400 });
    patch.avatar = a || patch.handle || "";
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nada que cambiar" }, { status: 400 });

  const { error } = await db.from("profiles").update(patch).eq("id", profileId);
  if (error) {
    // unique index on handle is the real guard against a check-then-update race
    if (/duplicate|unique/i.test(error.message)) return NextResponse.json({ error: "Ese usuario ya existe." }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (releasedHandle) {
    // old links keep working: /u/<old> redirects to the current handle
    await db.from("handle_history").upsert({ handle: releasedHandle, profile_id: profileId, released_at: new Date().toISOString() }, { onConflict: "handle" });
    await db.from("handle_history").delete().eq("handle", patch.handle); // taking back your own old name clears its hold
  }
  const profile = await loadProfile({ id: profileId }, profileId);
  return NextResponse.json({ ...profile, email: id.email });
}
