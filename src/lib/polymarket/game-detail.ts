import "server-only";
import { GAMMA_API_URL } from "./constants";
import { DEFAULT_FEE } from "./odds";
import { LEAGUES, LEAGUE_BY_ID, type LeagueId } from "./leagues";
import { sameTeam, shortTeam, type Game, type GameMarket, type GameOutcome, type MarketKind, type Period } from "./gamma";

/**
 * Every market Polymarket offers for ONE game, trimmed for the phone.
 *
 * Polymarket keeps a game's markets in its event (US sports: everything; soccer: only the
 * 1X2) and, for soccer, in a companion "<slug>-more-markets" event (spreads, totals, BTTS,
 * team totals, halves). Both are fetched in parallel, closed/non-trading markets dropped,
 * and each market classified into a kind + period + group with an es-MX label. The raw NBA
 * event is ~1.6 MB; what leaves here is ~30 KB.
 */

export interface DetailMarket extends GameMarket {
  period: Period;
  /** Chip the market belongs to on the game page */
  group: "ganador" | "handicap" | "total" | "btts" | "equipo" | "props" | "otros";
  /** Team (team totals) or player (props) */
  subject?: string;
  /** Props: points | rebounds | assists | threes | steals | blocks */
  stat?: string;
  /** es-MX section title, e.g. "Hándicap · 1ª mitad" */
  label: string;
}

export interface GameDetail {
  game: Omit<Game, "markets">;
  markets: DetailMarket[];
  /** Total count before trimming non-trading markets (for "N mercados") */
  offered: number;
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
  active?: boolean;
  closed?: boolean;
  liquidityNum?: number;
  liquidity?: string | number;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; exponent?: number };
  groupItemTitle?: string;
}
interface GammaEvent {
  id: string | number;
  slug: string;
  title: string;
  startDate?: string;
  image?: string;
  icon?: string;
  score?: string;
  elapsed?: string;
  period?: string;
  live?: boolean;
  ended?: boolean;
  markets?: (GammaMarket & { gameStartTime?: string })[];
}

const TTL_MS = 45_000;
const cache = new Map<string, { at: number; detail: GameDetail | null }>();

export const PERIOD_LABEL: Record<Period, string> = { full: "", "1h": "1ª mitad", "2h": "2ª mitad", q1: "1er cuarto", q2: "2º cuarto", q3: "3er cuarto", q4: "4º cuarto" };
export const STAT_LABEL: Record<string, string> = { points: "Puntos", rebounds: "Rebotes", assists: "Asistencias", threes: "Triples", steals: "Robos", blocks: "Bloqueos" };

export async function fetchGameDetail(slug: string): Promise<GameDetail | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.detail;
  const league = LEAGUES.find((l) => slug.startsWith(`${l.slugPrefix}-`))?.id;
  if (!league) return null;
  const [main, more] = await Promise.all([fetchEvent(slug), fetchEvent(`${slug}-more-markets`)]);
  const detail = main ? build(league, main, more) : null;
  cache.set(slug, { at: Date.now(), detail });
  return detail;
}

async function fetchEvent(slug: string): Promise<GammaEvent | null> {
  const r = await fetch(`${GAMMA_API_URL}/events?slug=${encodeURIComponent(slug)}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!r.ok) return null;
  const j = (await r.json()) as GammaEvent[];
  return Array.isArray(j) && j[0] ? j[0] : null;
}

function build(league: LeagueId, ev: GammaEvent, more: GammaEvent | null): GameDetail {
  const cfg = LEAGUE_BY_ID[league];
  const all = [...(ev.markets ?? []), ...(more?.markets ?? [])];
  const offered = all.length;
  const { home, away, homeRaw, awayRaw } = parseTeams(ev.title);
  const teamOrder = [homeRaw, awayRaw];
  const startTime = toIso(all.find((m) => m.gameStartTime)?.gameStartTime ?? ev.startDate);
  const game: Omit<Game, "markets"> = {
    id: String(ev.id),
    slug: ev.slug.replace(/-more-markets$/, ""),
    league,
    title: ev.title,
    startTime,
    image: ev.image ?? ev.icon ?? null,
    pmScore: ev.score ? { score: ev.score, elapsed: ev.elapsed, period: ev.period, live: ev.live, ended: ev.ended } : undefined,
    away,
    home,
  };

  const markets: DetailMarket[] = [];
  const threeWay: Record<Period, GammaMarket[]> = { full: [], "1h": [], "2h": [], q1: [], q2: [], q3: [], q4: [] };
  for (const m of all) {
    if (m.closed || m.active === false || m.acceptingOrders === false) continue;
    const type = m.sportsMarketType ?? "";
    const period = periodOf(type);
    const baseType = type.replace(/^(first_half_|second_half_|q[1-4]_|soccer_first_half_|soccer_second_half_|soccer_)/, "").replace(/_first_half$|_second_half$|_points$/, "");
    const p = parsed(m);
    if (!p) continue;

    // Soccer 1X2 = three yes/no markets; collect and merge per period.
    if (baseType === "moneyline" && cfg.threeWay && /^(yes|no)$/i.test(p.outcomes[0] ?? "")) {
      threeWay[period].push(m);
      continue;
    }
    const dm = classify(m, p, baseType, period, { home, away, homeRaw, awayRaw, teamOrder });
    if (dm) markets.push(dm);
  }
  for (const period of Object.keys(threeWay) as Period[]) {
    const merged = mergeThreeWay(threeWay[period], { home, away, homeRaw, awayRaw }, period);
    if (merged) markets.push(merged);
  }
  return { game, markets, offered };
}

function periodOf(type: string): Period {
  if (/first_half/.test(type) || /^1h/.test(type)) return "1h";
  if (/second_half/.test(type)) return "2h";
  const q = type.match(/^q([1-4])_/);
  return q ? (`q${q[1]}` as Period) : "full";
}

const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const withPeriod = (label: string, period: Period) => (period === "full" ? label : `${label} · ${PERIOD_LABEL[period]}`);

function classify(
  m: GammaMarket,
  p: { outcomes: string[]; prices: number[]; tokens: string[] },
  baseType: string,
  period: Period,
  t: { home: string; away: string; homeRaw: string; awayRaw: string; teamOrder: string[] },
): DetailMarket | null {
  const line = m.line == null ? null : Number(m.line);
  const out = (i: number, label: string): GameOutcome => ({ label, tokenId: p.tokens[i], price: p.prices[i] ?? 0 });
  const yesNo = (yesLabel: string, noLabel: string) => {
    const y = p.outcomes.findIndex((o) => /^yes$/i.test(o));
    const n = p.outcomes.findIndex((o) => /^no$/i.test(o));
    return y >= 0 && n >= 0 ? [out(y, yesLabel), out(n, noLabel)] : null;
  };
  const overUnder = (suffix = "") => {
    const o = p.outcomes.findIndex((x) => /^(over|yes)$/i.test(x));
    const u = p.outcomes.findIndex((x) => /^(under|no)$/i.test(x));
    return o >= 0 && u >= 0 && line != null ? [out(o, `Más ${line}${suffix}`), out(u, `Menos ${line}${suffix}`)] : null;
  };

  switch (baseType) {
    case "moneyline": {
      if (p.outcomes.length < 2) return null;
      return mk(m, "moneyline", null, period, "ganador", withPeriod("Ganador", period), p.outcomes.map((o, i) => out(i, shortTeam(o))));
    }
    case "spreads": {
      if (p.outcomes.length !== 2 || line == null) return null;
      const a = shortTeam(p.outcomes[0]);
      const b = shortTeam(p.outcomes[1]);
      const outcomes = [out(0, `${a} ${fmtLine(line)}`), out(1, `${b} ${fmtLine(-line)}`)];
      // Column A = the first-named team, always. `line` becomes that column's line so a ladder sorts cleanly.
      const first = t.teamOrder[0];
      const reversed = !!first && !sameTeam(p.outcomes[0], first) && sameTeam(p.outcomes[1], first);
      if (reversed) outcomes.reverse();
      return mk(m, "spread", reversed ? -line : line, period, "handicap", withPeriod("Hándicap", period), outcomes);
    }
    case "totals": {
      const o = overUnder();
      return o ? mk(m, "total", line, period, "total", withPeriod("Total", period), o) : null;
    }
    case "team_totals": {
      const o = overUnder();
      if (!o) return null;
      // "Steelers Team Total: O/U 10.5" · "Timberwolves 1H Team Total: O/U 56.5" · "A vs. B: Chelsea FC O/U 0.5" · "…: Chelsea FC 1st Half O/U 0.5"
      const q = m.question.includes(": ") && /vs\.?/.test(m.question.split(": ")[0]) ? m.question.split(": ").slice(1).join(": ") : m.question;
      const teamRaw = q.replace(/\s*(1H|2H|1st Half|2nd Half)?\s*Team Total.*$/i, "").replace(/\s*(1st Half|2nd Half)?\s*O\/U.*$/i, "").trim();
      const team = shortTeam(teamRaw);
      return { ...mk(m, "team_total", line, period, "equipo", withPeriod(`Total ${team}`, period), o), subject: team };
    }
    case "both_teams_to_score": {
      const o = yesNo("Sí", "No");
      return o ? mk(m, "btts", null, period, "btts", withPeriod("Ambos anotan", period), o) : null;
    }
    case "points":
    case "rebounds":
    case "assists":
    case "threes":
    case "steals":
    case "blocks": {
      const o = overUnder();
      if (!o) return null;
      const player = m.question.split(":")[0].trim();
      return { ...mk(m, "prop", line, period, "props", `${STAT_LABEL[baseType] ?? baseType} · ${player}`, o), subject: player, stat: baseType };
    }
    case "exact_margin": {
      const o = yesNo("Sí", "No");
      if (!o) return null;
      const what = m.question.replace(/^Exact Margin:\s*/i, "").replace(/\bby\b/i, "por");
      return mk(m, "yesno", null, period, "otros", `Margen exacto · ${shortTeam(what.split(" por ")[0])} por ${what.split(" por ")[1] ?? ""}`.trim(), o);
    }
    default: {
      // Anything else Polymarket adds: show it under "Otros" with its own question.
      const q = m.question.includes(": ") ? m.question.split(": ").slice(1).join(": ") : m.question;
      if (p.outcomes.length === 2 && /^yes$/i.test(p.outcomes[0]) && /^no$/i.test(p.outcomes[1])) {
        return mk(m, "yesno", line, period, "otros", withPeriod(translateQuestion(q), period), [out(0, "Sí"), out(1, "No")]);
      }
      if (p.outcomes.length === 2 && /^over$/i.test(p.outcomes[0])) {
        const o = overUnder();
        return o ? mk(m, "total", line, period, "otros", withPeriod(translateQuestion(q.replace(/\s*O\/U.*$/i, "")), period), o) : null;
      }
      if (p.outcomes.length >= 2) {
        return mk(m, "yesno", line, period, "otros", withPeriod(translateQuestion(q), period), p.outcomes.map((o, i) => out(i, shortTeam(o))));
      }
      return null;
    }
  }
}

function translateQuestion(q: string): string {
  return q
    .replace(/Team to Score First/i, "Primero en anotar")
    .replace(/Odd\/Even Score/i, "Marcador par / impar")
    .replace(/Overtime\?/i, "¿Tiempo extra?")
    .replace(/Race to (\d+) Points?/i, "Carrera a $1 puntos")
    .replace(/Safety\?/i, "¿Safety?")
    .replace(/Total Two-Point Conversions/i, "Conversiones de 2 puntos")
    .replace(/Total Offensive Yards/i, "Yardas totales")
    .replace(/Total Touchdowns/i, "Touchdowns")
    .replace(/Both Teams to Score Points(\s*-\s*\dQ)?/i, "Ambos anotan")
    .replace(/\s*O\/U\s*[\d.]+$/i, "");
}

function mk(m: GammaMarket, kind: MarketKind, line: number | null, period: Period, group: DetailMarket["group"], label: string, outcomes: GameOutcome[]): DetailMarket {
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
    liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
    fee: m.feesEnabled === false ? { rate: 0, exponent: 1 } : { rate: Number(m.feeSchedule?.rate ?? DEFAULT_FEE.rate), exponent: Number(m.feeSchedule?.exponent ?? 1) },
    period,
    group,
    label,
    outcomes,
  };
}

function mergeThreeWay(ms: GammaMarket[], t: { home: string; away: string; homeRaw: string; awayRaw: string }, period: Period): DetailMarket | null {
  if (ms.length < 2) return null;
  const picks: { key: "home" | "draw" | "away"; m: GammaMarket }[] = [];
  for (const m of ms) {
    const g = (m.groupItemTitle ?? "").toLowerCase();
    const q = m.question.toLowerCase();
    const key: "home" | "draw" | "away" | null = /draw|empate|tie/.test(g) || /end in a draw/.test(q) ? "draw" : sameTeam(g || q, t.homeRaw) ? "home" : sameTeam(g || q, t.awayRaw) ? "away" : null;
    if (key && !picks.some((x) => x.key === key)) picks.push({ key, m });
  }
  if (picks.length < 2) return null;
  const order = { home: 0, draw: 1, away: 2 };
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
  return { ...mk(first, "moneyline", null, period, "ganador", withPeriod("Ganador", period), outcomes), negRisk: picks.some((x) => x.m.negRisk) || first.negRisk === true };
}

// ---------------------------------------------------------------- small helpers (mirrors gamma.ts)

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

function parseTeams(title: string): { away: string; home: string; awayRaw: string; homeRaw: string } {
  const parts = title.replace(/\s*-\s*More Markets$/i, "").split(/\s+vs\.?\s+/i);
  if (parts.length === 2) {
    const homeRaw = parts[0].trim();
    const awayRaw = parts[1].trim();
    return { away: shortTeam(awayRaw), home: shortTeam(homeRaw), awayRaw, homeRaw };
  }
  return { away: "", home: shortTeam(title), awayRaw: "", homeRaw: title };
}

function toIso(s: string | undefined): string {
  if (!s) return new Date(0).toISOString();
  const d = new Date(s.replace(" ", "T").replace(/\+00$/, "Z"));
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
