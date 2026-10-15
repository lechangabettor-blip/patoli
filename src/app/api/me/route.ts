import { NextRequest, NextResponse, connection } from "next/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { isOwnedDepositWallet } from "@/lib/polymarket/wallet-derive";
import { loadProfile } from "@/lib/social";

/**
 * POST /api/me { walletAddress }  (Bearer <Magic DID token>)
 * Creates the profile on first login (handle from email), returns it.
 * GET /api/me → the caller's profile.
 */
export async function POST(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) {
    return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  }
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { walletAddress?: string; handle?: string };
  const wallet = (body.walletAddress ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !isOwnedDepositWallet(id.eoa, wallet)) {
    return NextResponse.json({ error: "wallet no corresponde a esta cuenta" }, { status: 400 });
  }
  const db = supabaseAdmin();

  const { data: priv } = await db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  let profileId = priv?.profile_id as string | undefined;

  if (!profileId) {
    const handle = await uniqueHandle(suggestHandle(id.email, id.eoa));
    const { data: p, error } = await db
      .from("profiles")
      .insert({ handle, display_name: handle, avatar: handle, eoa: id.eoa, wallet })
      .select("id")
      .single();
    if (error || !p) return NextResponse.json({ error: error?.message ?? "no se pudo crear el perfil" }, { status: 500 });
    profileId = p.id as string;
    await db.from("profile_private").insert({ profile_id: profileId, issuer: id.issuer, email: id.email });
  } else {
    // keep wallet current (e.g. after the Safe→deposit-wallet migration)
    await db.from("profiles").update({ wallet, eoa: id.eoa }).eq("id", profileId);
  }

  const profile = await loadProfile({ id: profileId }, profileId);
  return NextResponse.json({ ...profile, email: id.email });
}

export async function GET(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json(null, { status: 503 });
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json(null, { status: 401 });
  const db = supabaseAdmin();
  const { data: priv } = await db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  if (!priv) return NextResponse.json(null, { status: 404 });
  const profile = await loadProfile({ id: priv.profile_id as string }, priv.profile_id as string);
  return NextResponse.json(profile ? { ...profile, email: id.email } : null);
}

function suggestHandle(email: string | null, eoa: string): string {
  const base = (email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  if (base.length >= 3) return base;
  return `banda_${eoa.slice(2, 8)}`;
}

async function uniqueHandle(base: string): Promise<string> {
  const db = supabaseAdmin();
  let candidate = base;
  for (let i = 0; i < 50; i++) {
    const { data } = await db.from("profiles").select("id").eq("handle", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base.slice(0, 16)}_${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  return `${base.slice(0, 12)}_${Date.now().toString(36)}`;
}
