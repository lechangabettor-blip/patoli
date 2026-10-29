import "server-only";
import { GAMMA_API_URL } from "./constants";
import type { FeeSchedule } from "./odds";
import type { ProtocolVersion } from "./protocol";
import { LEAGUE_BY_ID, PROTOCOL_PREFIX, leagueOfSlug, type LeagueId, type League } from "./leagues";
import { ttlCache } from "@/lib/ttl-cache";
import { alertOps } from "@/lib/alert";
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
  /**
   * Polymarket protocol: "v1" = CTF outcome tokens on the CTF exchange, "v2" = Protocol V2 positions
   * (ExchangeV3, PositionManager, Router). Decides how an order is keyed and how winnings are redeemed.
   */
  version: ProtocolVersion;
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
  // Gamma serves one protocol per request and hides Protocol V2 unless asked (2026-10-29), so each
  // market type is fetched for both versions; the row limit applies per request.
  const [ml, alts, totals] = await Promise.all([
    fetchBothVersions(cfg.tagId, "moneyline", "gameStartTime", true, 200),
    fetchBothVersions(cfg.tagId, cfg.threeWay ? "both_teams_to_score" : "spreads", "liquidityNum", false, 100),
    fetchBothVersions(cfg.tagId, "totals", "liquidityNum", false, 100),
  ]);

  const slugRe = new RegExp(`^(polyv2-?)?${cfg.slugPrefix}-[a-z0-9]+-[a-z0-9]+-\\d{4}-\\d{2}-\\d{2}(-\\d)?$`);
  const byGame = new Map<string, { ml: GammaMarket[]; alt?: GammaMarket; total?: GammaMarket }>();
  let unmatched = 0; // scheduled-game moneylines (gameStartTime set) whose event slug follows a convention we do not know
  const sourceEvent = new Map<string, string>(); // V2 canary slug → the v1 event id it mirrors
  const bucket = (m: GammaMarket) => {
    const slug = baseSlug(m);
    if (!slug || !slugRe.test(slug)) {
      // Futures are typed "moneyline" too (NFL season-series winners) but carry no gameStartTime.
      if (slug && m.sportsMarketType === "moneyline" && m.gameStartTime) unmatched++;
      return null;
    }
    const src = m.marketMetadata?.polyv2SourceEventId;
    if (src != null) sourceEvent.set(slug, String(src));
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

  // Protocol V2 canaries mirror v1 events (slug prefix `polyv2-`, or `polyv2SourceEventId` naming
  // the v1 event): same game, ids on another exchange. Of two copies on the board the bettable one
  // stays — an open moneyline with more liquidity, v1 on a tie — so the board follows the money
  // whichever protocol Polymarket moves it to. Ops hears the first time a V2 copy wins.
  const bettability = (g: Game) => {
    const ml = g.markets.find((m) => m.kind === "moneyline");
    return !ml || !ml.acceptingOrders ? -1 : ml.liquidity;
  };
  const byId = new Map(games.map((g) => [g.id, g]));
  const bySlug = new Map(games.map((g) => [g.slug, g]));
  const dropped = new Set<string>();
  for (const g of games) {
    if (!g.markets.some((m) => m.version === "v2")) continue;
    const src = sourceEvent.get(g.slug);
    const twin = bySlug.get(g.slug.replace(PROTOCOL_PREFIX, "")) ?? (src ? byId.get(src) : undefined);
    if (!twin || twin === g) {
      // A canary copy whose v1 original already left the board (the game started and its moneyline
      // closed) is a leftover, not a new listing: V2 orphans stay only before kickoff.
      const canary = PROTOCOL_PREFIX.test(g.slug) || !!src;
      if (canary && !twin && Date.parse(g.startTime) < Date.now()) dropped.add(g.slug);
      continue;
    }
    const loser = bettability(g) > bettability(twin) ? twin : g;
    dropped.add(loser.slug);
    if (loser === twin) void alertOps("protocol-v2-twin-won", `${league}: the V2 copy of ${twin.slug} replaced its v1 twin on the board`, 24 * 60 * 60_000).catch(() => {});
  }
  const board = games.filter((g) => !dropped.has(g.slug));
  board.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.slug.localeCompare(b.slug));
  // The day Polymarket lists a league's games as Protocol V2 (tentatively from 2026-11-02) ops
  // should hear it once, without waiting for a player to notice anything — and hear it too when a
  // whole slate arrives under a slug convention the board rules reject.
  const v2Games = board.filter((g) => g.markets.some((m) => m.version === "v2")).length;
  if (v2Games > 0) void alertOps("protocol-v2-on-board", `${v2Games} Protocol V2 game(s) on the ${league} board`, 24 * 60 * 60_000).catch(() => {});
  if (unmatched > 0 && (board.length === 0 || unmatched >= 10)) {
    void alertOps(`board-unmatched-slugs:${league}`, `${league}: ${unmatched} moneyline(s) rejected by the slug rule, ${board.length} game(s) shown — new slug convention?`, 6 * 60 * 60_000).catch(() => {});
  }
  cache.set(league, board);
  return board.slice(0, limit);
}

export async function fetchGameBySlug(slug: string): Promise<Game | null> {
  const league = leagueOfSlug(slug);
  if (!league) return null;
  const games = await fetchGames(league, 200);
  return games.find((g) => g.slug === slug) ?? null;
}

type BoardType = "moneyline" | "spreads" | "totals" | "both_teams_to_score";

/**
 * Both protocols of one market type, as two requests (a combined `version=v1&version=v2` call is
 * capped at 100 rows). Each leg is a complete board for its protocol, so one failed or slow leg
 * must never blank the other: a failed leg contributes nothing and alerts ops; only both failing
 * fails the board.
 */
async function fetchBothVersions(tagId: string, type: BoardType, order: string, ascending: boolean, limit: number): Promise<GammaMarket[]> {
  const versions = ["v1", "v2"] as const;
  const legs = await Promise.allSettled(versions.map((version) => fetchMarkets(tagId, type, order, ascending, limit, version)));
  if (legs.every((l) => l.status === "rejected")) throw (legs[0] as PromiseRejectedResult).reason;
  const out: GammaMarket[] = [];
  legs.forEach((l, i) => {
    if (l.status === "fulfilled") out.push(...l.value);
    else void alertOps(`gamma-list-${versions[i]}`, `Gamma ${type} list (tag ${tagId}, ${versions[i]}) failed: ${String(l.reason).slice(0, 120)}`, 60 * 60_000).catch(() => {});
  });
  return out;
}

async function fetchMarkets(tagId: string, type: BoardType, order: string, ascending: boolean, limit: number, version: ProtocolVersion): Promise<GammaMarket[]> {
  const params = new URLSearchParams({
    tag_id: tagId,
    sports_market_types: type,
    closed: "false",
    active: "true",
    order,
    ascending: String(ascending),
    limit: String(limit),
    version,
  });
  const res = await fetch(`${GAMMA_API_URL}/markets?${params}`, {
    headers: { accept: "application/json" },
    cache: "no-store", // payloads exceed Next's 2 MB data-cache limit; we cache in memory
    signal: AbortSignal.timeout(8_000), // a hung leg must not hold the board either
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
