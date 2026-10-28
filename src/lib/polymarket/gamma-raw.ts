import "server-only";
import { DEFAULT_FEE } from "./odds";
import type { GameMarket, GameOutcome, MarketKind } from "./gamma";
import { sameTeam, shortTeam } from "./teams";

export { sameTeam, shortTeam } from "./teams";

/**
 * Raw Gamma shapes + the parsing shared by the board (gamma.ts), the game page
 * (game-detail.ts) and the indexer. One copy of each, no behaviour of its own.
 */

export interface GammaEventRef {
  id: string | number;
  slug: string;
  title: string;
  startDate?: string;
  image?: string;
  icon?: string;
  // live game data Polymarket attaches to sports events
  score?: string; // "74-68", title order
  elapsed?: string; // "05:27"
  period?: string; // "Q3", "2H"…
  live?: boolean;
  ended?: boolean;
}

export interface GammaMarket {
  id: string | number;
  conditionId: string;
  question: string;
  slug?: string;
  outcomes?: string; // JSON array of labels
  outcomePrices?: string; // JSON array of prices
  clobTokenIds?: string; // JSON array of token ids
  sportsMarketType?: string;
  line?: number | string | null;
  negRisk?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  acceptingOrders?: boolean;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean; rebateRate?: number };
  liquidityNum?: number;
  liquidity?: string | number;
  gameStartTime?: string;
  groupItemTitle?: string;
  closed?: boolean;
  active?: boolean;
  umaResolutionStatus?: string;
  events?: GammaEventRef[];
}

export interface ParsedMarket {
  outcomes: string[];
  prices: number[];
  tokens: string[];
}

/** The three JSON-encoded arrays of a market, or null when they do not line up. */
export function parsed(m: GammaMarket): ParsedMarket | null {
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

export const liq = (m: GammaMarket) => Number(m.liquidityNum ?? m.liquidity ?? 0);

/** Everything a GameMarket carries besides its outcomes: ids, trading params, the real fee. */
export function marketCore(m: GammaMarket, kind: MarketKind, line: number | null): Omit<GameMarket, "outcomes"> {
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
    fee:
      m.feesEnabled === false
        ? { rate: 0, exponent: 1 }
        : { rate: Number(m.feeSchedule?.rate ?? DEFAULT_FEE.rate), exponent: Number(m.feeSchedule?.exponent ?? 1), takerOnly: m.feeSchedule?.takerOnly === true },
  };
}

/** "2026-10-19 00:20:00+00" (gameStartTime) or ISO → ISO; epoch 0 when unknown. */
export function toIso(s: string | undefined): string {
  if (!s) return new Date(0).toISOString();
  const d = new Date(s.replace(" ", "T").replace(/\+00$/, "Z"));
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export interface Teams {
  away: string;
  home: string;
  awayRaw: string;
  homeRaw: string;
}

/**
 * Polymarket titles: US sports "Away vs. Home"; soccer "Home vs. Away". We only need the
 * two names; order is handled by the league's `threeWay`. "- More Markets" is the soccer
 * companion event's suffix.
 */
export function parseTeams(title: string): Teams {
  const parts = title.replace(/\s*-\s*More Markets$/i, "").split(/\s+vs\.?\s+/i);
  if (parts.length === 2) {
    const homeRaw = parts[0].trim();
    const awayRaw = parts[1].trim();
    return { away: shortTeam(awayRaw), home: shortTeam(homeRaw), awayRaw, homeRaw };
  }
  return { away: "", home: shortTeam(title), awayRaw: "", homeRaw: title };
}

/**
 * Soccer 1X2: three yes/no markets (home win, draw, away win) → the YES side of each, in
 * home · draw · away order. Null unless at least two of the three are present.
 */
export function threeWayOutcomes(ms: GammaMarket[], t: Teams): { outcomes: GameOutcome[]; first: GammaMarket; negRisk: boolean } | null {
  type Key = "home" | "draw" | "away";
  const picks: { key: Key; m: GammaMarket }[] = [];
  for (const m of ms) {
    const g = (m.groupItemTitle ?? "").toLowerCase();
    const q = m.question.toLowerCase();
    const key: Key | null = /draw|empate|tie/.test(g) || /end in a draw/.test(q) ? "draw" : sameTeam(g || q, t.homeRaw) ? "home" : sameTeam(g || q, t.awayRaw) ? "away" : null;
    if (key && !picks.some((x) => x.key === key)) picks.push({ key, m });
  }
  if (picks.length < 2) return null;
  const order: Record<Key, number> = { home: 0, draw: 1, away: 2 };
  picks.sort((a, b) => order[a.key] - order[b.key]);
  const outcomes: GameOutcome[] = [];
  for (const { key, m } of picks) {
    const p = parsed(m);
    if (!p) continue;
    const yes = p.outcomes.findIndex((o) => o.toLowerCase() === "yes");
    const i = yes >= 0 ? yes : 0;
    outcomes.push({ label: key === "draw" ? "Empate" : key === "home" ? t.home : t.away, tokenId: p.tokens[i], price: p.prices[i] ?? 0 });
  }
  if (outcomes.length < 2) return null;
  const first = picks[0].m;
  return { outcomes, first, negRisk: picks.some((x) => x.m.negRisk) || first.negRisk === true };
}
