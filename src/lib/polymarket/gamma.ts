import "server-only";
import { GAMMA_API_URL } from "./constants";
import { LEAGUES, LEAGUE_BY_ID, type LeagueId, type League } from "./leagues";

/**
 * Server-side reads of Polymarket's Gamma API, normalized to what the Sports
 * tab needs. We query the /markets endpoint filtered by sportsMarketType
 * (hundreds of KB) instead of /events (10–30 MB per league, every prop and
 * alt line included) and keep a short in-memory cache per league.
 *
 * Per game we expose: the moneyline (soccer's three yes/no markets merged
 * into one three-way line), the most liquid spread and the most liquid total.
 */

/** btts = "both teams to score" (soccer only; replaces the spread row there) */
export type MarketKind = "moneyline" | "spread" | "total" | "btts";

export interface GameOutcome {
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
}

const TTL_MS = 45_000;
const cache = new Map<LeagueId, { at: number; games: Game[] }>();

/** Longest a game of each sport can plausibly run, kickoff to final whistle (incl. OT / stoppage). */
const MAX_GAME_MS: Record<League["sport"], number> = { soccer: 2.25 * 3600_000, basketball: 3 * 3600_000, football: 4 * 3600_000 };

export async function fetchGames(league: LeagueId, limit = 40): Promise<Game[]> {
  const hit = cache.get(league);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.games.slice(0, limit);

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
      away,
      home,
      markets,
    });
  }

  games.sort((a, b) => a.startTime.localeCompare(b.startTime));
  cache.set(league, { at: Date.now(), games });
  return games.slice(0, limit);
}

export async function fetchGameBySlug(slug: string): Promise<Game | null> {
  const league = LEAGUES.find((l) => slug.startsWith(`${l.slugPrefix}-`))?.id;
  if (!league) return null;
  const games = await fetchGames(league, 200);
  return games.find((g) => g.slug === slug) ?? null;
}

// ---------------------------------------------------------------- Gamma types

interface GammaEventRef {
  id: string | number;
  slug: string;
  title: string;
  startDate?: string;
  image?: string;
  icon?: string;
}

interface GammaMarket {
  id: string | number;
  conditionId: string;
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  sportsMarketType?: string;
  line?: number | string | null;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  acceptingOrders?: boolean;
  liquidityNum?: number;
  liquidity?: string | number;
  gameStartTime?: string;
  groupItemTitle?: string;
  closed?: boolean;
  active?: boolean;
  events?: GammaEventRef[];
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

function parsed(m: GammaMarket): { outcomes: string[]; prices: number[]; tokens: string[] } | null {
  try {
    const outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
    const prices = (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
    const tokens = JSON.parse(m.clobTokenIds ?? "[]") as string[];
    if (tokens.length === 0 || outcomes.length !== tokens.length) return null;
    return { outcomes, prices, tokens };
  } catch {
    return null;
  }
}

function base(m: GammaMarket, kind: MarketKind, line: number | null): Omit<GameMarket, "outcomes"> {
  return {
    id: String(m.id),
    conditionId: m.conditionId,
    kind,
    question: m.question,
    line,
    negRisk: !!m.negRisk,
    tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
    minOrderSize: Number(m.orderMinSize ?? 5),
    acceptingOrders: m.acceptingOrders !== false,
    liquidity: liq(m),
  };
}

/** US-style moneyline: one market, outcomes are the two teams. */
function twoWay(m: GammaMarket): GameMarket | null {
  const p = parsed(m);
  if (!p) return null;
  return {
    ...base(m, "moneyline", null),
    outcomes: p.outcomes.map((label, i) => ({ label: shortTeam(label), tokenId: p.tokens[i], price: p.prices[i] ?? 0 })),
  };
}

/** Soccer: three yes/no markets (home win, draw, away win) → one 3-way line. */
function mergeThreeWay(
  markets: GammaMarket[],
  t: { home: string; away: string; homeRaw: string; awayRaw: string },
): GameMarket | null {
  const { home, away, homeRaw, awayRaw } = t;
  const picks: { key: "home" | "draw" | "away"; m: GammaMarket }[] = [];
  for (const m of markets) {
    const g = (m.groupItemTitle ?? "").toLowerCase();
    const q = m.question.toLowerCase();
    const key: "home" | "draw" | "away" | null = /draw|empate|tie/.test(g) || /end in a draw/.test(q)
      ? "draw"
      : sameTeam(g || q, homeRaw)
        ? "home"
        : sameTeam(g || q, awayRaw)
          ? "away"
          : null;
    if (key && !picks.some((x) => x.key === key)) picks.push({ key, m });
  }
  if (picks.length < 2) return null;
  const order: Record<"home" | "draw" | "away", number> = { home: 0, draw: 1, away: 2 };
  picks.sort((a, b) => order[a.key] - order[b.key]);
  const outcomes: GameOutcome[] = [];
  for (const { key, m } of picks) {
    const p = parsed(m);
    if (!p) continue;
    const yes = p.outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const i = yes >= 0 ? yes : 0;
    outcomes.push({ label: key === "draw" ? "Empate" : key === "home" ? home : away, tokenId: p.tokens[i], price: p.prices[i] ?? 0 });
  }
  if (outcomes.length < 2) return null;
  const first = picks[0].m;
  return { ...base(first, "moneyline", null), negRisk: picks.some((x) => x.m.negRisk) || first.negRisk === true, outcomes };
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
  return { ...base(m, "spread", line), outcomes };
}

/** Soccer "Both Teams to Score": Yes/No → "Ambos anotan · Sí / No". */
function bttsMarket(m: GammaMarket): GameMarket | null {
  const p = parsed(m);
  if (!p || p.outcomes.length !== 2) return null;
  const yes = p.outcomes.findIndex((o) => /^yes$/i.test(o));
  const no = p.outcomes.findIndex((o) => /^no$/i.test(o));
  if (yes < 0 || no < 0) return null;
  return {
    ...base(m, "btts", null),
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
    ...base(m, "total", line),
    outcomes: p.outcomes.map((o, i) => ({
      label: line == null ? word(o) : `${word(o)} ${line}`,
      tokenId: p.tokens[i],
      price: p.prices[i] ?? 0,
    })),
  };
}

// ---------------------------------------------------------------- helpers

const liq = (m: GammaMarket) => Number(m.liquidityNum ?? m.liquidity ?? 0);

function baseSlug(m: GammaMarket): string | null {
  const s = m.events?.[0]?.slug;
  return s ? s.replace(/-more-markets$/, "") : null;
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameTeam(text: string, team: string): boolean {
  const t = norm(team);
  const x = norm(text);
  if (!t) return false;
  if (x.includes(t)) return true;
  // fall back to the most distinctive word (e.g. "necaxa" in "Club Necaxa")
  const words = t.split(" ").filter((w) => w.length > 3 && !["club", "fc", "cf", "cd", "de", "la", "los", "las", "del", "united", "city"].includes(w));
  return words.some((w) => x.includes(w));
}

function parseTeams(title: string): { away: string; home: string; awayRaw: string; homeRaw: string } {
  // Polymarket titles: US sports "Away vs. Home"; soccer "Home vs. Away".
  // We only need the two names; order is handled by the league's `threeWay`.
  const parts = title.split(/\s+vs\.?\s+/i);
  if (parts.length === 2) {
    const homeRaw = parts[0].trim();
    const awayRaw = parts[1].trim();
    return { away: shortTeam(awayRaw), home: shortTeam(homeRaw), awayRaw, homeRaw };
  }
  return { away: "", home: shortTeam(title), awayRaw: "", homeRaw: title };
}

const TEAM_NOISE = new Set(["club", "fc", "cf", "cd", "sc", "rc", "rcd", "ud", "sd", "ac", "afc", "ss", "us", "as", "de", "la", "del", "unam", "uanl", "futbol", "fútbol"]);
const TEAM_OVERRIDES: Record<string, string> = {
  "Pumas de la UNAM": "Pumas",
  "Tigres de la UANL": "Tigres",
  "CD Guadalajara": "Chivas",
  "Club Atlético de Madrid": "Atlético",
  "RCD Espanyol de Barcelona": "Espanyol",
  "RC Deportivo A Coruña": "Deportivo",
  "Atlético de San Luis": "San Luis",
  "FC Juárez": "Juárez",
};

/** "Club Necaxa" → "Necaxa", "Atlas FC" → "Atlas". Full names stay in the game title. */
export function shortTeam(raw: string): string {
  const name = raw.trim();
  if (TEAM_OVERRIDES[name]) return TEAM_OVERRIDES[name];
  const words = name.split(/\s+/);
  const kept = words.filter((w) => !TEAM_NOISE.has(w.toLowerCase().replace(/\./g, "")));
  return (kept.length ? kept : words).join(" ");
}

function toIso(s: string | undefined): string {
  if (!s) return new Date(0).toISOString();
  // gameStartTime comes as "2026-10-19 00:20:00+00"
  const d = new Date(s.replace(" ", "T").replace(/\+00$/, "Z"));
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
