import { NextRequest, NextResponse, connection } from "next/server";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { runIndexer, type IndexRunResult } from "@/lib/indexer";

/**
 * POST /api/me/sync  (Bearer <Magic DID token>)
 * Lets a logged-in user pull the indexer right after placing a bet, so their
 * new bet shows up in Perfil/feed without waiting for the cron. The indexer is
 * idempotent and global, so one run serves everyone; a short throttle keeps a
 * tapping user (or a script) from hammering Polymarket.
 */
const MIN_GAP_MS = 4_000;
let lastRunAt = 0;
let lastResult: IndexRunResult | null = null;
let inflight: Promise<IndexRunResult> | null = null;

export async function POST(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const id = await verifyDidToken(bearer(req));
  if (!id) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });

  if (inflight) return NextResponse.json(await inflight);
  if (lastResult && Date.now() - lastRunAt < MIN_GAP_MS) return NextResponse.json({ ...lastResult, throttled: true });

  inflight = runIndexer({ maxPages: 2 }).finally(() => {
    inflight = null;
  });
  try {
    lastResult = await inflight;
    lastRunAt = Date.now();
    return NextResponse.json(lastResult);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sync failed" }, { status: 500 });
  }
}
