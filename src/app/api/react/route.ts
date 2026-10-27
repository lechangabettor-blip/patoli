import { NextRequest, NextResponse, connection } from "next/server";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { isMagicAdminConfigured } from "@/lib/magic-admin";
import { resolveViewer } from "@/lib/social";

const BET_ID = /^[0-9a-f-]{36}$/i;
const BATTLE_ID = /^battle:0x[0-9a-f]{64}$/i;

const KINDS = new Set(["fire", "tail", "fade"]);

/**
 * POST /api/react { id, on: boolean, kind?: "fire" | "tail" | "fade" }  (Bearer DID token)
 * → { kind, count, on, fire, fired } for that feed item (fire/fired kept for the 🔥 client).
 *
 * "tail"/"fade" are social proof, so the client's word is not enough: the row is written only
 * when the viewer owns a BUY fill (indexed in `bets`) on the source pick's token (tail) or on
 * the other token of the same market (fade), placed after the source pick, by someone other
 * than its author, while the pick is still open. Until the indexer has the fill → 202 pending
 * (the sheet retries). They can never be removed through this endpoint.
 */
export async function POST(req: NextRequest) {
  await connection();
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return NextResponse.json({ error: "backend no configurado" }, { status: 503 });
  const viewerId = await resolveViewer(req);
  if (!viewerId) return NextResponse.json({ error: "sesión inválida" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; on?: boolean; kind?: string };
  const kind = body.kind ?? "fire";
  if (!KINDS.has(kind)) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  // Canonical form = exactly what the feed emits (lowercase), so "0xAB…" and "0xab…" are one key.
  const id = (body.id ?? "").trim().toLowerCase();
  if (!BET_ID.test(id) && !BATTLE_ID.test(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  if (kind !== "fire" && !BET_ID.test(id)) return NextResponse.json({ error: "solo picks deportivos" }, { status: 400 });
  const db = supabaseAdmin();

  // Only react to things that exist (keeps the table honest).
  const exists = BATTLE_ID.test(id)
    ? (await db.from("arena_matches").select("id").eq("id", id.slice("battle:".length)).maybeSingle()).data
    : (await db.from("bets").select("id").eq("id", id).maybeSingle()).data;
  if (!exists) return NextResponse.json({ error: "no existe" }, { status: 404 });

  if (kind !== "fire") {
    if (body.on === false) return NextResponse.json({ error: "no se puede quitar" }, { status: 400 });
    const verdict = await verifyTail(db, id, viewerId, kind as "tail" | "fade");
    if (typeof verdict === "string") return NextResponse.json({ error: verdict, pending: verdict === "pendiente" }, { status: verdict === "pendiente" ? 202 : 409 });
    // One reaction per fill: the unique index on proof_bet_id makes a reused proof fail here.
    const { error } = await db.from("reactions").upsert({ bet_id: id, profile_id: viewerId, kind, proof_bet_id: verdict.proof }, { onConflict: "bet_id,profile_id,kind", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: "no se pudo guardar" }, { status: 500 });
  } else if (body.on === false) {
    await db.from("reactions").delete().eq("bet_id", id).eq("profile_id", viewerId).eq("kind", "fire");
  } else {
    const { error } = await db.from("reactions").upsert({ bet_id: id, profile_id: viewerId, kind: "fire" }, { onConflict: "bet_id,profile_id,kind", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: "no se pudo guardar" }, { status: 500 });
  }
  const { count } = await db.from("reactions").select("bet_id", { count: "exact", head: true }).eq("bet_id", id).eq("kind", kind);
  const on = body.on !== false;
  return NextResponse.json({ kind, count: count ?? 0, on, fire: count ?? 0, fired: on });
}

type Db = ReturnType<typeof supabaseAdmin>;

/**
 * { proof } = the viewer's own fill that backs this tail/fade (one not already spent on another
 * reaction) · "pendiente" = fill not indexed yet · any other string = it can never count.
 */
async function verifyTail(db: Db, sourceId: string, viewerId: string, side: "tail" | "fade"): Promise<{ proof: string } | string> {
  const { data: src } = await db
    .from("bets")
    .select("id, profile_id, token_id, status, matched_at, markets!bets_condition_id_fkey(outcomes)")
    .eq("id", sourceId)
    .maybeSingle();
  if (!src) return "no existe";
  if (src.profile_id === viewerId) return "es tu propio pick";
  if (src.status !== "open") return "pick cerrado";
  const outcomes = ((src.markets as unknown as { outcomes?: { tokenId: string | null }[] } | null)?.outcomes ?? []).map((o) => o.tokenId).filter(Boolean) as string[];
  const target = side === "tail" ? (src.token_id as string) : outcomes.length === 2 ? outcomes.find((t) => t !== src.token_id) : undefined;
  if (!target) return "sin lado contrario";
  const { data: mine } = await db
    .from("bets")
    .select("id")
    .eq("profile_id", viewerId)
    .eq("side", "BUY")
    .eq("token_id", target)
    .gte("matched_at", src.matched_at as string)
    .order("matched_at", { ascending: true })
    .limit(20);
  const fills = (mine ?? []).map((b) => b.id as string);
  if (fills.length === 0) return "pendiente";
  const { data: spent } = await db.from("reactions").select("proof_bet_id, bet_id").in("proof_bet_id", fills);
  const already = (spent ?? []).find((r) => r.bet_id === sourceId);
  if (already) return { proof: already.proof_bet_id as string }; // same reaction again → idempotent
  const used = new Set((spent ?? []).map((r) => r.proof_bet_id as string));
  const free = fills.find((f) => !used.has(f));
  return free ? { proof: free } : "pendiente";
}
