import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { searchProfiles } from "@/lib/social";
import { demoProfiles } from "@/lib/demo-feed";

/** GET /api/users?q=… → profiles (search, or newest when q is empty) */
export async function GET(req: NextRequest) {
  await connection();
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!isSupabaseConfigured()) {
    const all = demoProfiles();
    const n = q.toLowerCase();
    return NextResponse.json({ items: n ? all.filter((u) => u.handle.includes(n) || (u.displayName ?? "").toLowerCase().includes(n)) : all, demo: true });
  }
  const items = await searchProfiles(q);
  return NextResponse.json({ items, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
