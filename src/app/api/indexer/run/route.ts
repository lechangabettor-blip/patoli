import { NextRequest, NextResponse, connection } from "next/server";
import { runIndexer } from "@/lib/indexer";
import { isSupabaseConfigured } from "@/lib/supabase/server";

/**
 * POST /api/indexer/run  (header: x-indexer-secret)
 * Also GET for Vercel Cron (sends CRON_SECRET as a bearer).
 */
async function handle(req: NextRequest) {
  await connection();
  const secret = process.env.INDEXER_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const ok =
    (secret && req.headers.get("x-indexer-secret") === secret) ||
    (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) ||
    process.env.NODE_ENV === "development";
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "Supabase no está configurado" }, { status: 503 });
  try {
    const result = await runIndexer();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "indexer failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
