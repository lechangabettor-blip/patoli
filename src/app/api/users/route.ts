import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { searchProfiles } from "@/lib/social";

/** GET /api/users?q=… → profiles (search, or the week's table when q is empty; scope=rail = everyone who settled a pick this week) */
export async function GET(req: NextRequest) {
  await connection();
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!isSupabaseConfigured()) return NextResponse.json({ items: [], demo: false }, { status: 503 });
  const items = await searchProfiles(q, 20, req.nextUrl.searchParams.get("scope") === "rail");
  return NextResponse.json({ items, demo: false }, { headers: { "Cache-Control": "no-store" } });
}
