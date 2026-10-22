import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/polymarket/gamma";
import { isLeagueId } from "@/lib/polymarket/leagues";
import { liveScores } from "@/lib/scores";

/** GET /api/scores?league=nba → { [gameSlug]: LiveScore } for games in play (ESPN, Polymarket fallback) */
export async function GET(request: NextRequest) {
  const league = request.nextUrl.searchParams.get("league");
  if (!isLeagueId(league)) return NextResponse.json({ error: "league inválida" }, { status: 400 });
  try {
    const games = await fetchGames(league);
    const scores = await liveScores(league, games);
    return NextResponse.json(scores, { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" } });
  } catch {
    return NextResponse.json({}, { headers: { "Cache-Control": "no-store" } });
  }
}
