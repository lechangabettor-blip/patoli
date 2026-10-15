import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { loadFeed } from "@/lib/social";
import { demoFeed } from "@/lib/demo-feed";

/** GET /api/feed?scope=all|following&before=<iso>  (optional Bearer DID token for "following") */
export async function GET(req: NextRequest) {
  await connection();
  const scope = req.nextUrl.searchParams.get("scope") === "following" ? "following" : "all";
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ items: demoFeed(scope), demo: true });
  }
  let viewerId: string | null = null;
  if (scope === "following" && isMagicAdminConfigured()) {
    const id = await verifyDidToken(bearer(req));
    if (id) {
      const { data } = await supabaseAdmin().from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
      viewerId = (data?.profile_id as string) ?? null;
    }
  }
  const items = await loadFeed({ scope, viewerId, before });
  return NextResponse.json({ items, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
