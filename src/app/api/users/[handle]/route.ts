import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { loadFeed, loadProfile } from "@/lib/social";
import { demoFeed, demoProfile } from "@/lib/demo-feed";

/** GET /api/users/[handle] → { profile, bets } */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/users/[handle]">) {
  await connection();
  const { handle } = await ctx.params;
  if (!isSupabaseConfigured()) {
    const profile = demoProfile(handle);
    if (!profile) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ profile, bets: demoFeed("profile", handle), demo: true });
  }
  let viewerId: string | null = null;
  if (isMagicAdminConfigured()) {
    const id = await verifyDidToken(bearer(req));
    if (id) {
      const { data } = await supabaseAdmin().from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
      viewerId = (data?.profile_id as string) ?? null;
    }
  }
  const profile = await loadProfile({ handle }, viewerId);
  if (!profile) return NextResponse.json({ error: "not found" }, { status: 404 });
  const bets = await loadFeed({ scope: "profile", profileId: profile.id, limit: 50 });
  return NextResponse.json({ profile, bets, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
