// Leagues offered in v1. Tag ids verified live against
// https://gamma-api.polymarket.com/tags/slug/<slug> on 2026-10-14.

export type LeagueId = "ligamx" | "nfl" | "nba" | "ucl" | "epl" | "laliga";

export interface League {
  id: LeagueId;
  /** Short label for chips */
  label: string;
  /** Full name */
  name: string;
  /** Gamma tag id used to list events */
  tagId: string;
  /** Slug prefix used on game events, e.g. "nfl-dal-gb-2026-10-19" */
  slugPrefix: string;
  sport: "soccer" | "football" | "basketball";
  /** Whether a draw outcome exists on the moneyline */
  threeWay: boolean;
  emoji: string;
}

export const LEAGUES: League[] = [
  { id: "ligamx", label: "Liga MX", name: "Liga MX", tagId: "102448", slugPrefix: "mex", sport: "soccer", threeWay: true, emoji: "🇲🇽" },
  { id: "nfl", label: "NFL", name: "NFL", tagId: "450", slugPrefix: "nfl", sport: "football", threeWay: false, emoji: "🏈" },
  { id: "nba", label: "NBA", name: "NBA", tagId: "745", slugPrefix: "nba", sport: "basketball", threeWay: false, emoji: "🏀" },
  { id: "ucl", label: "Champions", name: "UEFA Champions League", tagId: "1234", slugPrefix: "ucl", sport: "soccer", threeWay: true, emoji: "🏆" },
  { id: "epl", label: "Premier", name: "Premier League", tagId: "82", slugPrefix: "epl", sport: "soccer", threeWay: true, emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "laliga", label: "La Liga", name: "La Liga", tagId: "780", slugPrefix: "lal", sport: "soccer", threeWay: true, emoji: "🇪🇸" },
];

export const LEAGUE_BY_ID: Record<LeagueId, League> = Object.fromEntries(
  LEAGUES.map((l) => [l.id, l]),
) as Record<LeagueId, League>;

export function isLeagueId(v: string | null | undefined): v is LeagueId {
  return !!v && v in LEAGUE_BY_ID;
}
