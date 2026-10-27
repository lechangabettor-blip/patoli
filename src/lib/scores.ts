import "server-only";
import { ttlCache } from "@/lib/ttl-cache";
import type { Game } from "@/lib/polymarket/gamma";
import { sameTeam } from "@/lib/polymarket/gamma";
import type { LeagueId } from "@/lib/polymarket/leagues";

/**
 * Live scores for the board. Primary source: ESPN's public scoreboard (unofficial, no key,
 * ~10–20 s behind the broadcast). Fallback: the score Polymarket attaches to its own event
 * (~45 s behind). The card never depends on ESPN being up: if it fails or a game does not
 * match, the Polymarket score is used; if neither exists, the card just shows "En vivo".
 */

export interface LiveScore {
  /** Score in the same order as the game's title (first-named team first). */
  first: number;
  second: number;
  /** "Q3", "2nd", "1T", "HT", "OT"… as the source reports it */
  period: string;
  /** "05:27", "45'+2"… or "" */
  clock: string;
  state: "in" | "post";
  source: "espn" | "polymarket";
}

const ESPN_PATH: Record<LeagueId, string> = {
  nba: "basketball/nba",
  nfl: "football/nfl",
  mlb: "baseball/mlb",
  ligamx: "soccer/mex.1",
  epl: "soccer/eng.1",
  laliga: "soccer/esp.1",
  ucl: "soccer/uefa.champions",
};

interface EspnEvent {
  date: string;
  competitions: {
    status: { type: { state: "pre" | "in" | "post"; shortDetail: string }; period: number; displayClock: string };
    competitors: { homeAway: "home" | "away"; score: string; team: { displayName: string; shortDisplayName: string; name: string; location: string } }[];
  }[];
}

const cache = ttlCache<LeagueId, EspnEvent[]>(8_000);

async function espnEvents(league: LeagueId): Promise<EspnEvent[]> {
  const hit = cache.get(league);
  if (hit) return hit;
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[league]}/scoreboard`, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
  if (!r.ok) throw new Error(`espn ${r.status}`);
  const j = (await r.json()) as { events?: EspnEvent[] };
  return cache.set(league, j.events ?? []);
}

const teamNames = (t: EspnEvent["competitions"][0]["competitors"][0]["team"]) => [t.displayName, t.shortDisplayName, t.name, t.location];
const isTeam = (c: EspnEvent["competitions"][0]["competitors"][0], ours: string) => teamNames(c.team).some((n) => n && (sameTeam(n, ours) || sameTeam(ours, n)));

/** Period label the way a Mexican bettor reads it. */
function periodLabel(league: LeagueId, period: number, state: "in" | "post", clock: string): { period: string; clock: string } {
  if (state === "post") return { period: "Final", clock: "" };
  const soccer = league !== "nba" && league !== "nfl";
  if (soccer) {
    if (period === 1 && clock === "45'") return { period: "MT", clock: "" };
    return { period: period <= 1 ? "1T" : period === 2 ? "2T" : "TE", clock };
  }
  if (league === "nba") return { period: period <= 4 ? `Q${period}` : `OT${period > 5 ? period - 4 : ""}`, clock };
  return { period: period <= 4 ? `Q${period}` : "OT", clock };
}

/** Scores for the live games of a league, keyed by game slug. */
export async function liveScores(league: LeagueId, games: Game[]): Promise<Record<string, LiveScore>> {
  const now = Date.now();
  const live = games.filter((g) => now - Date.parse(g.startTime) >= 0);
  const out: Record<string, LiveScore> = {};
  if (live.length === 0) return out;

  let events: EspnEvent[] = [];
  try {
    events = await espnEvents(league);
  } catch {
    /* fall through to Polymarket */
  }

  for (const g of live) {
    const ev = events.find((e) => {
      const c = e.competitions[0];
      if (!c || c.status.type.state === "pre") return false;
      if (Math.abs(Date.parse(e.date) - Date.parse(g.startTime)) > 6 * 3600_000) return false;
      return c.competitors.some((x) => isTeam(x, g.home)) && c.competitors.some((x) => isTeam(x, g.away));
    });
    if (ev) {
      const c = ev.competitions[0];
      const first = c.competitors.find((x) => isTeam(x, g.home));
      const second = c.competitors.find((x) => isTeam(x, g.away));
      if (first && second && first !== second) {
        const state = c.status.type.state === "post" ? "post" : "in";
        out[g.slug] = { first: Number(first.score), second: Number(second.score), ...periodLabel(league, c.status.period, state, c.status.displayClock), state, source: "espn" };
        continue;
      }
    }
    // Fallback: Polymarket's own score (title order = outcome order on its side).
    const pm = g.pmScore;
    if (pm?.score) {
      const [a, b] = pm.score.split("-").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        out[g.slug] = { first: a, second: b, period: pm.period ?? "", clock: pm.elapsed ?? "", state: pm.ended ? "post" : "in", source: "polymarket" };
      }
    }
  }
  return out;
}
