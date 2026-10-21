import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { attachFire, attachLive, loadBattles, loadFeed, loadProfile, mergeFeed, resolveViewer } from "@/lib/social";

/** GET /api/users/[handle] → { profile, bets } */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/users/[handle]">) {
  await connection();
  const { handle } = await ctx.params;
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const viewerId = await resolveViewer(req);
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
  const items = await attachLive(await attachFire(mergeFeed(bets, battles, 100), viewerId));
  return NextResponse.json({ profile, bets: items, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
