import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/polymarket/gamma";
import { isLeagueId } from "@/lib/polymarket/leagues";

/** GET /api/games?league=nfl → upcoming games with moneyline/spread/total markets */
export async function GET(request: NextRequest) {
  const league = request.nextUrl.searchParams.get("league");
  if (!isLeagueId(league)) {
    return NextResponse.json({ error: "league inválida" }, { status: 400 });
  }
  try {
    const games = await fetchGames(league);
    return NextResponse.json(games, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e) {
    console.error("games error", e);
    return NextResponse.json({ error: "No pudimos cargar los partidos" }, { status: 502 });
  }
}
