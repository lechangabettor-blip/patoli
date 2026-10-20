import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { loadBattles, loadFeed, loadProfile, mergeFeed } from "@/lib/social";

/** GET /api/users/[handle] → { profile, bets } */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/users/[handle]">) {
  await connection();
  const { handle } = await ctx.params;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  let viewerId: string | null = null;
  if (isMagicAdminConfigured()) {
    const id = await verifyDidToken(bearer(req));
    if (id) {
      const { data } = await supabaseAdmin().from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
      viewerId = (data?.profile_id as string) ?? null;
    }
  }
  let profile = await loadProfile({ handle }, viewerId);
  if (!profile) {
    // Renamed? Old handles redirect to their owner — but only when NO profile
    // (banned ones included, which loadProfile hides) currently owns the name.
    const db = supabaseAdmin();
    const { data: owner } = await db.from("profiles").select("id").eq("handle", handle.toLowerCase()).maybeSingle();
    if (!owner) {
      const { data: old } = await db.from("handle_history").select("profile_id").eq("handle", handle.toLowerCase()).maybeSingle();
      if (old) profile = await loadProfile({ id: old.profile_id as string }, viewerId);
    }
  }
  if (!profile) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [bets, battles] = await Promise.all([
    loadFeed({ scope: "profile", profileId: profile.id, limit: 50 }),
    loadBattles({ scope: "profile", profileId: profile.id, limit: 50 }),
  ]);
  return NextResponse.json({ profile, bets: mergeFeed(bets, battles, 100), demo: false }, { headers: { "Cache-Control": "no-store" } });
}
