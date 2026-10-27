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
 * "tail"/"fade" are written by the bet sheet once a Súbaseee/Bájeseee bet is really placed.
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

  if (body.on === false) {
    await db.from("reactions").delete().eq("bet_id", id).eq("profile_id", viewerId).eq("kind", kind);
  } else {
    const { error } = await db.from("reactions").upsert({ bet_id: id, profile_id: viewerId, kind }, { onConflict: "bet_id,profile_id,kind", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: "no se pudo guardar" }, { status: 500 });
  }
  const { count } = await db.from("reactions").select("bet_id", { count: "exact", head: true }).eq("bet_id", id).eq("kind", kind);
  const on = body.on !== false;
  return NextResponse.json({ kind, count: count ?? 0, on, fire: count ?? 0, fired: on });
}
