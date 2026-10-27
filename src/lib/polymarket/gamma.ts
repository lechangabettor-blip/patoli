import "server-only";
import { GAMMA_API_URL } from "./constants";
import type { FeeSchedule } from "./odds";
import { LEAGUES, LEAGUE_BY_ID, type LeagueId, type League } from "./leagues";
import { ttlCache } from "@/lib/ttl-cache";
import { liq, marketCore, parseTeams, parsed, sameTeam, shortTeam, threeWayOutcomes, toIso, type GammaMarket, type Teams } from "./gamma-raw";

export { sameTeam, shortTeam } from "./gamma-raw";

/**
 * Server-side reads of Polymarket's Gamma API, normalized to what the Sports
 * tab needs. We query the /markets endpoint filtered by sportsMarketType
 * (hundreds of KB) instead of /events (10–30 MB per league, every prop and
 * alt line included) and keep a short in-memory cache per league.
 *
 * Per game we expose: the moneyline (soccer's three yes/no markets merged
 * into one three-way line), the most liquid spread and the most liquid total.
 */

/** btts = both teams to score · team_total = one team's O/U · prop = player O/U · yesno = any other two-way market */
export type MarketKind = "moneyline" | "spread" | "total" | "btts" | "team_total" | "prop" | "yesno";
/** Part of the game a market covers */
export type Period = "full" | "1h" | "2h" | "q1" | "q2" | "q3" | "q4" | "f5";

export interface GameOutcome {
  /** USD on the ask side within 2¢ of the best ask (game page only; from the order book) */
  depth?: number;
  /** Display label, already localized: "Seahawks -2.5", "Más 46.5", "Empate" */
  label: string;
  tokenId: string;
  /** Last displayed price (0–1). Realtime price comes from the CLOB. */
  price: number;
}

export interface GameMarket {
  id: string;
  conditionId: string;
  kind: MarketKind;
  question: string;
  line: number | null;
  negRisk: boolean;
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  liquidity: number;
  /** Polymarket's taker fee for this market: per share = rate · (p·(1−p))^exponent */
  fee: FeeSchedule;
  /** es-MX section label when the market comes from the game page (e.g. "Hándicap · 1ª mitad") */
  label?: string;
  outcomes: GameOutcome[];
}

export interface Game {
  id: string;
  slug: string;
  league: LeagueId;
  title: string;
  /** Kickoff / tip-off in ISO (UTC) */
  startTime: string;
  image: string | null;
  away: string;
  home: string;
  markets: GameMarket[];
  /** Polymarket's own live score (fallback for the ESPN feed) */
  pmScore?: { score?: string; elapsed?: string; period?: string; live?: boolean; ended?: boolean };
}

const cache = ttlCache<LeagueId, Game[]>(45_000);

/** Longest a game of each sport can plausibly run, kickoff to final whistle (incl. OT / stoppage). */
const MAX_GAME_MS: Record<League["sport"], number> = { soccer: 2.25 * 3600_000, basketball: 3 * 3600_000, football: 4 * 3600_000, baseball: 4.5 * 3600_000 };

export async function fetchGames(league: LeagueId, limit = 40): Promise<Game[]> {
  const hit = cache.get(league);
  if (hit) return hit.slice(0, limit);

  const cfg = LEAGUE_BY_ID[league];
  // Soccer shows "Ambos anotan" where US sports show the spread (LeChanga, 2026-10-16).
  const [ml, alts, totals] = await Promise.all([
    fetchMarkets(cfg.tagId, "moneyline", "gameStartTime", true, 200),
    fetchMarkets(cfg.tagId, cfg.threeWay ? "both_teams_to_score" : "spreads", "liquidityNum", false, 100),
    fetchMarkets(cfg.tagId, "totals", "liquidityNum", false, 100),
  ]);

  const slugRe = new RegExp(`^${cfg.slugPrefix}-[a-z0-9]+-[a-z0-9]+-\\d{4}-\\d{2}-\\d{2}(-\\d)?$`);
  const byGame = new Map<string, { ml: GammaMarket[]; alt?: GammaMarket; total?: GammaMarket }>();
  const bucket = (m: GammaMarket) => {
    const slug = baseSlug(m);
    if (!slug || !slugRe.test(slug)) return null;
    let b = byGame.get(slug);
    if (!b) {
      b = { ml: [] };
      byGame.set(slug, b);
    }
    return b;
  };
  for (const m of ml) bucket(m)?.ml.push(m);
  for (const m of alts) {
    const b = bucket(m);
    if (b && (!b.alt || liq(m) > liq(b.alt))) b.alt = m;
  }
  for (const m of totals) {
    const b = bucket(m);
    if (b && (!b.total || liq(m) > liq(b.total))) b.total = m;
  }

  // In-play games stay on the board (live bets, 2026-10-21); a game leaves once it is surely over.
  const cutoff = Date.now() - MAX_GAME_MS[cfg.sport];
  const games: Game[] = [];
  for (const [slug, b] of byGame) {
    if (b.ml.length === 0) continue;
    const ev = b.ml[0].events?.[0];
    const title = ev?.title ?? b.ml[0].question;
    const { away, home, awayRaw, homeRaw } = parseTeams(title);
    const startTime = toIso(b.ml[0].gameStartTime ?? ev?.startDate);
    if (new Date(startTime).getTime() < cutoff) continue;

    const markets: GameMarket[] = [];
    const moneyline = cfg.threeWay ? mergeThreeWay(b.ml, { home, away, homeRaw, awayRaw }) : twoWay(b.ml[0]);
    if (moneyline) markets.push(moneyline);
    if (b.alt) {
      const m = cfg.threeWay ? bttsMarket(b.alt) : spreadMarket(b.alt, moneyline?.outcomes.map((o) => o.label) ?? []);
      if (m) markets.push(m);
    }
    if (b.total) {
      const m = totalMarket(b.total);
      if (m) markets.push(m);
    }
    if (markets.length === 0) continue;

    games.push({
      id: String(ev?.id ?? b.ml[0].id),
      slug,
      league,
      title,
      startTime,
      image: ev?.image ?? ev?.icon ?? null,
      pmScore: ev?.score ? { score: ev.score, elapsed: ev.elapsed, period: ev.period, live: ev.live, ended: ev.ended } : undefined,
      away,
      home,
      markets,
    });
  }

  games.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.slug.localeCompare(b.slug));
  cache.set(league, games);
  return games.slice(0, limit);
}

export async function fetchGameBySlug(slug: string): Promise<Game | null> {
  const league = LEAGUES.find((l) => slug.startsWith(`${l.slugPrefix}-`))?.id;
  if (!league) return null;
  const games = await fetchGames(league, 200);
  return games.find((g) => g.slug === slug) ?? null;
}

async function fetchMarkets(
  tagId: string,
  type: "moneyline" | "spreads" | "totals" | "both_teams_to_score",
  order: string,
  ascending: boolean,
  limit: number,
): Promise<GammaMarket[]> {
  const params = new URLSearchParams({
    tag_id: tagId,
    sports_market_types: type,
    closed: "false",
    active: "true",
    order,
    ascending: String(ascending),
    limit: String(limit),
  });
  const res = await fetch(`${GAMMA_API_URL}/markets?${params}`, {
    headers: { accept: "application/json" },
    cache: "no-store", // payloads exceed Next's 2 MB data-cache limit; we cache in memory
  });
  if (!res.ok) throw new Error(`Gamma ${type} ${res.status}`);
  const data = (await res.json()) as GammaMarket[];
  return Array.isArray(data) ? data.filter((m) => !m.closed && m.active !== false) : [];
}

// ---------------------------------------------------------------- normalizers



/** US-style moneyline: one market, outcomes are the two teams. */
function twoWay(m: GammaMarket): GameMarket | null {
  const p = parsed(m);
  if (!p) return null;
  return {
    ...marketCore(m, "moneyline", null),
    outcomes: p.outcomes.map((label, i) => ({ label: shortTeam(label), tokenId: p.tokens[i], price: p.prices[i] ?? 0 })),
  };
}

/** Soccer: three yes/no markets (home win, draw, away win) → one 3-way line. */
function mergeThreeWay(markets: GammaMarket[], t: Teams): GameMarket | null {
  const tw = threeWayOutcomes(markets, t);
  return tw ? { ...marketCore(tw.first, "moneyline", null), negRisk: tw.negRisk, outcomes: tw.outcomes } : null;
}

/**
 * Spread. Polymarket lists the favorite first; we show the two teams in the same
 * left/right order as the moneyline row so a card reads as one game (LeChanga, 2026-10-21).
 */
function spreadMarket(m: GammaMarket, teamOrder: string[]): GameMarket | null {
  const p = parsed(m);
  if (!p || p.outcomes.length !== 2) return null;
  const line = m.line == null ? null : Number(m.line);
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const a = shortTeam(p.outcomes[0]);
  const b = shortTeam(p.outcomes[1]);
  const outcomes = [
    { label: line == null ? a : `${a} ${fmt(line)}`, tokenId: p.tokens[0], price: p.prices[0] ?? 0 },
    { label: line == null ? b : `${b} ${fmt(-line)}`, tokenId: p.tokens[1], price: p.prices[1] ?? 0 },
  ];
  const first = teamOrder[0];
  if (first && !sameTeam(p.outcomes[0], first) && sameTeam(p.outcomes[1], first)) outcomes.reverse();
  return { ...marketCore(m, "spread", line), outcomes };
}

/** Soccer "Both Teams to Score": Yes/No → "Ambos anotan · Sí / No". */
function bttsMarket(m: GammaMarket): GameMarket | null {
  const p = parsed(m);
  if (!p || p.outcomes.length !== 2) return null;
  const yes = p.outcomes.findIndex((o) => /^yes$/i.test(o));
  const no = p.outcomes.findIndex((o) => /^no$/i.test(o));
  if (yes < 0 || no < 0) return null;
  return {
    ...marketCore(m, "btts", null),
    outcomes: [
      { label: "Ambos anotan · Sí", tokenId: p.tokens[yes], price: p.prices[yes] ?? 0 },
      { label: "Ambos anotan · No", tokenId: p.tokens[no], price: p.prices[no] ?? 0 },
    ],
  };
}

function totalMarket(m: GammaMarket): GameMarket | null {
  const p = parsed(m);
  if (!p || p.outcomes.length !== 2) return null;
  const line = m.line == null ? null : Number(m.line);
  const word = (o: string) => (/over/i.test(o) ? "Más" : /under/i.test(o) ? "Menos" : o);
  return {
    ...marketCore(m, "total", line),
    outcomes: p.outcomes.map((o, i) => ({
      label: line == null ? word(o) : `${word(o)} ${line}`,
      tokenId: p.tokens[i],
      price: p.prices[i] ?? 0,
    })),
  };
}

// ---------------------------------------------------------------- helpers


function baseSlug(m: GammaMarket): string | null {
  const s = m.events?.[0]?.slug;
  return s ? s.replace(/-more-markets$/, "") : null;
}
