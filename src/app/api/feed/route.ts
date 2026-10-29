import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { attachFire, attachLive, loadBattles, loadFeed, mergeFeed, resolveViewer } from "@/lib/social";

/** Rows asked from each source per page */
const LIMIT = 30;

/**
 * GET /api/feed?scope=all|following&before=<iso>
 * (optional Bearer DID token: needed for "following", and marks the viewer's 🔥)
 * → { items, nextBefore }. The feed merges two independently limited sources (bets, battles) by
 * time. A source that filled its page may have rows right behind its oldest one, so the page shows
 * nothing older than the newest such tail; `nextBefore` = that tail (inclusive, the client drops
 * the repeated row by id) and the next page continues from there. No full source → last page.
 */
export async function GET(req: NextRequest) {
  await connection();
  const scope = req.nextUrl.searchParams.get("scope") === "following" ? "following" : "all";
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  if (!isSupabaseConfigured()) return NextResponse.json({ items: [], nextBefore: null, demo: false }, { status: 503 });
  const viewerId = await resolveViewer(req);
  const [bets, battles] = await Promise.all([loadFeed({ scope, viewerId, before, limit: LIMIT }), loadBattles({ scope, viewerId, before, limit: LIMIT })]);
  const tails = [bets, battles].filter((s) => s.length >= LIMIT).map((s) => s[s.length - 1].placedAt);
  const nextBefore = tails.length ? tails.reduce((a, b) => (a > b ? a : b)) : null;
  const merged = mergeFeed(bets, battles, Infinity);
  const items = nextBefore ? merged.filter((i) => i.placedAt >= nextBefore) : merged;
  await Promise.all([attachFire(items, viewerId), attachLive(items)]); // independent fields, one round trip
  return NextResponse.json({ items, nextBefore, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
