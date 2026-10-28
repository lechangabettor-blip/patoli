import { NextRequest, NextResponse, connection } from "next/server";
import { GAMMA_API_URL } from "@/lib/polymarket/constants";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";

export interface MarketInfo {
  question: string;
  eventTitle: string | null;
  eventSlug: string | null;
  league: string | null;
  gameStart: string | null;
}

/**
 * POST /api/markets/lookup { conditionIds: string[] } → { [conditionId]: MarketInfo }
 * Labels for open limit orders (Polymarket's open-orders feed carries only ids). Our own
 * markets table first (anything ever bet through Patoli), Gamma for the rest.
 */
export async function POST(req: NextRequest) {
  await connection();
  const body = (await req.json().catch(() => ({}))) as { conditionIds?: string[] };
  const ids = [...new Set((body.conditionIds ?? []).filter((c) => /^0x[0-9a-f]{64}$/i.test(c)).map((c) => c.toLowerCase()))].slice(0, 50);
  const out: Record<string, MarketInfo> = {};
  if (ids.length === 0) return NextResponse.json(out);

  if (isSupabaseConfigured()) {
    const { data } = await supabaseAdmin().from("markets").select("condition_id, question, event_title, event_slug, league, game_start").in("condition_id", ids);
    for (const m of data ?? []) out[String(m.condition_id).toLowerCase()] = { question: m.question as string, eventTitle: (m.event_title as string) ?? null, eventSlug: (m.event_slug as string) ?? null, league: (m.league as string) ?? null, gameStart: (m.game_start as string) ?? null };
  }
  const missing = ids.filter((c) => !out[c]);
  if (missing.length) {
    const u = new URL(`${GAMMA_API_URL}/markets`);
    for (const c of missing) u.searchParams.append("condition_ids", c);
    const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const ms = r?.ok ? ((await r.json()) as { conditionId: string; question: string; gameStartTime?: string; events?: { title?: string; slug?: string }[] }[]) : [];
    for (const m of ms) {
      const ev = m.events?.[0];
      out[m.conditionId.toLowerCase()] = { question: m.question, eventTitle: ev?.title ?? null, eventSlug: ev?.slug ?? null, league: null, gameStart: m.gameStartTime ?? null };
    }
  }
  return NextResponse.json(out, { headers: { "cache-control": "private, max-age=60" } });
}
