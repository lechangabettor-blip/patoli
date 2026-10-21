import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { attachFire, loadBattles, loadFeed, mergeFeed, resolveViewer } from "@/lib/social";

/** GET /api/feed?scope=all|following&before=<iso>  (optional Bearer DID token: needed for "following", and marks the viewer's 🔥) */
export async function GET(req: NextRequest) {
  await connection();
  const scope = req.nextUrl.searchParams.get("scope") === "following" ? "following" : "all";
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  if (!isSupabaseConfigured()) return NextResponse.json({ items: [], demo: false }, { status: 503 });
  const viewerId = await resolveViewer(req);
  const [bets, battles] = await Promise.all([loadFeed({ scope, viewerId, before }), loadBattles({ scope, viewerId, before })]);
  const items = await attachFire(mergeFeed(bets, battles), viewerId);
  return NextResponse.json({ items, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
