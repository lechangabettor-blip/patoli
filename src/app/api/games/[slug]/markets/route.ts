import { NextRequest, NextResponse } from "next/server";
import { fetchGameDetail } from "@/lib/polymarket/game-detail";

/** GET /api/games/[slug]/markets → every market Polymarket offers for the game, trimmed and labelled */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/games/[slug]/markets">) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{5,80}$/.test(slug)) return NextResponse.json({ error: "slug inválido" }, { status: 400 });
  try {
    const detail = await fetchGameDetail(slug);
    if (!detail) return NextResponse.json({ error: "Partido no encontrado" }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    console.error("game markets error", e);
    return NextResponse.json({ error: "No pudimos cargar los mercados" }, { status: 502 });
  }
}
