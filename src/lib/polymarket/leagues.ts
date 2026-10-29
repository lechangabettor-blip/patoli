// Leagues offered in v1. Tag ids verified live against
// https://gamma-api.polymarket.com/tags/slug/<slug> on 2026-10-14; UCL re-verified 2026-10-21
// (tag 1234 "Champions League" only carries futures — game markets live under 100977 "UCL").

export type LeagueId = "ligamx" | "nfl" | "nba" | "mlb" | "ucl" | "epl" | "laliga";

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
  sport: "soccer" | "football" | "basketball" | "baseball";
  /** Whether a draw outcome exists on the moneyline */
  threeWay: boolean;
  emoji: string;
}

export const LEAGUES: League[] = [
  { id: "ligamx", label: "Liga MX", name: "Liga MX", tagId: "102448", slugPrefix: "mex", sport: "soccer", threeWay: true, emoji: "🇲🇽" },
  { id: "nfl", label: "NFL", name: "NFL", tagId: "450", slugPrefix: "nfl", sport: "football", threeWay: false, emoji: "🏈" },
  { id: "nba", label: "NBA", name: "NBA", tagId: "745", slugPrefix: "nba", sport: "basketball", threeWay: false, emoji: "🏀" },
  // Added 2026-10-27 for the World Series; tag 100381 = Gamma /sports "mlb" primaryTagId.
  { id: "mlb", label: "MLB", name: "MLB", tagId: "100381", slugPrefix: "mlb", sport: "baseball", threeWay: false, emoji: "⚾" },
  { id: "ucl", label: "Champions", name: "UEFA Champions League", tagId: "100977", slugPrefix: "ucl", sport: "soccer", threeWay: true, emoji: "🏆" },
  { id: "epl", label: "Premier", name: "Premier League", tagId: "82", slugPrefix: "epl", sport: "soccer", threeWay: true, emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "laliga", label: "La Liga", name: "La Liga", tagId: "780", slugPrefix: "lal", sport: "soccer", threeWay: true, emoji: "🇪🇸" },
];

export const LEAGUE_BY_ID: Record<LeagueId, League> = Object.fromEntries(
  LEAGUES.map((l) => [l.id, l]),
) as Record<LeagueId, League>;

export function isLeagueId(v: string | null | undefined): v is LeagueId {
  return !!v && v in LEAGUE_BY_ID;
}

/**
 * Polymarket's Protocol V2 canary events mirror v1 events under a `polyv2-` slug prefix (since
 * 2026-10); other V2 series glue it on without the hyphen (`polyv2bkbsl-…`), so both forms count.
 */
export const PROTOCOL_PREFIX = /^polyv2-?/;

/** League of a Gamma event slug, tolerating the Protocol V2 canary prefix (`polyv2-nba-…` → nba). */
export function leagueOfSlug(slug: string | null | undefined): LeagueId | null {
  if (!slug) return null;
  const base = slug.replace(PROTOCOL_PREFIX, "");
  return LEAGUES.find((l) => base.startsWith(`${l.slugPrefix}-`))?.id ?? null;
}
