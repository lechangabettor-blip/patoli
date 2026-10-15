import { NextRequest, NextResponse } from "next/server";
import { fetchGameBySlug } from "@/lib/polymarket/gamma";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/games/[slug]">) {
  const { slug } = await ctx.params;
  try {
    const game = await fetchGameBySlug(slug);
    if (!game) return NextResponse.json({ error: "Partido no encontrado" }, { status: 404 });
    return NextResponse.json(game, {
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" },
    });
  } catch (e) {
    console.error("game error", e);
    return NextResponse.json({ error: "No pudimos cargar el partido" }, { status: 502 });
  }
}
