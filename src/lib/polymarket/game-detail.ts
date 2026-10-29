import "server-only";
import { CLOB_API_URL, GAMMA_API_URL } from "./constants";
import { LEAGUE_BY_ID, PROTOCOL_PREFIX, leagueOfSlug, type LeagueId } from "./leagues";
import { ttlCache } from "@/lib/ttl-cache";
import { dominantVersion, marketCore, parseTeams, parsed, threeWayOutcomes, toIso, type GammaEventRef, type GammaMarket, type Teams } from "./gamma-raw";
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
  group: "ganador" | "doble" | "handicap" | "total" | "btts" | "equipo" | "props" | "otros";
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
  /**
   * A Protocol V2 canary: a `polyv2-` mirror of a v1 event (Gamma points at the source event). Its
   * books are bot-thin, so the page relaxes its depth rules to let the V2 path be exercised. A real
   * V2 game (no source event) keeps the normal rules whatever its slug looks like.
   */
  canary: boolean;
}

interface GammaEvent extends GammaEventRef {
  markets?: GammaMarket[];
}

const cache = ttlCache<string, GameDetail | null>(45_000);

const PERIOD_LABEL: Record<Period, string> = { full: "", "1h": "1ª mitad", "2h": "2ª mitad", q1: "1er cuarto", q2: "2º cuarto", q3: "3er cuarto", q4: "4º cuarto", f5: "1ras 5 entradas" };
const STAT_LABEL: Record<string, string> = { points: "Puntos", rebounds: "Rebotes", assists: "Asistencias", threes: "Triples", steals: "Robos", blocks: "Bloqueos" };

export async function fetchGameDetail(slug: string): Promise<GameDetail | null> {
  const hit = cache.get(slug);
  if (hit !== undefined) return hit;
  const league = leagueOfSlug(slug);
  if (!league) return null;
  const [main, more] = await Promise.all([fetchEvent(slug), fetchEvent(`${slug}-more-markets`, true)]);
  return cache.set(slug, main ? await withBooks(build(league, main, more)) : null);
}

/**
 * One event with its markets. The single-object endpoint serves both protocols without a `version`
 * flag — the list endpoint hides Protocol V2 events unless asked (verified 2026-10-29) — including
 * the soccer `-more-markets` companions and finished events. 404 = no such event.
 */
async function fetchEvent(slug: string, optional = false): Promise<GammaEvent | null> {
  const r = await fetch(`${GAMMA_API_URL}/events/slug/${encodeURIComponent(slug)}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (r.status === 404) return null; // no such event: a cacheable answer
  if (!r.ok) {
    if (optional) return null; // a companion the page can live without
    throw new Error(`Gamma events/slug ${r.status}`); // the route answers 502, uncached; the client retries
  }
  const j = (await r.json()) as GammaEvent | GammaEvent[] | null;
  const ev = Array.isArray(j) ? j[0] : j;
  return ev && typeof ev === "object" && typeof ev.slug === "string" ? ev : null;
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
  const threeWay: Record<Period, GammaMarket[]> = { full: [], "1h": [], "2h": [], q1: [], q2: [], q3: [], q4: [], f5: [] };
  for (const m of all) {
    if (m.closed || m.active === false || m.acceptingOrders === false) continue;
    const type = m.sportsMarketType ?? "";
    const period = periodOf(type);
    // Baseball: "baseball_team_first_five_spread|total" (singular) → the regular spreads/totals ladders, period f5.
    const baseType = type
      .replace(/^(first_half_|second_half_|q[1-4]_|soccer_first_half_|soccer_second_half_|soccer_|baseball_team_first_five_)/, "")
      .replace(/_first_half$|_second_half$|_points$/, "")
      .replace(/^spread$/, "spreads")
      .replace(/^total$/, "totals");
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
    const ms = dominantVersion(threeWay[period]); // Ganador and Doble oportunidad from one exchange only
    const merged = mergeThreeWay(ms, { home, away, homeRaw, awayRaw }, period);
    if (merged) markets.push(merged);
    const doble = dobleOportunidad(ms, { home, away, homeRaw, awayRaw }, period);
    if (doble) markets.push(doble);
  }
  const canary = PROTOCOL_PREFIX.test(game.slug) && all.some((m) => m.marketMetadata?.polyv2SourceEventId != null);
  return { game, markets, offered, canary };
}

/**
 * Doble oportunidad (soccer): "X o empate" = the NO side of the other team's win market,
 * "X o Y" = the NO side of the draw market. Same three markets as the 1X2, other outcome.
 */
function dobleOportunidad(ms: GammaMarket[], t: Teams, period: Period): DetailMarket | null {
  const find = (key: "home" | "draw" | "away") =>
    ms.find((m) => {
      const g = (m.groupItemTitle ?? "").toLowerCase();
      const q = m.question.toLowerCase();
      if (key === "draw") return /draw|empate|tie/.test(g) || /end in a draw/.test(q);
      return sameTeam(g || q, key === "home" ? t.homeRaw : t.awayRaw) && !/end in a draw/.test(q);
    });
  const no = (m: GammaMarket | undefined, label: string): GameOutcome | null => {
    const p = m ? parsed(m) : null;
    if (!p) return null;
    const i = p.outcomes.findIndex((o) => /^no$/i.test(o));
    return i < 0 ? null : { label, tokenId: p.tokens[i], price: p.prices[i] ?? 0 };
  };
  const outcomes = [no(find("away"), `${t.home} o Empate`), no(find("home"), `${t.away} o Empate`), no(find("draw"), `${t.home} o ${t.away}`)].filter((o): o is GameOutcome => !!o);
  if (outcomes.length < 2) return null;
  const first = find("away") ?? find("home") ?? ms[0];
  return { ...mk(first, "moneyline", null, period, "doble", withPeriod("Doble oportunidad", period), outcomes), negRisk: ms.some((m) => m.negRisk) };
}

/**
 * Real prices and depth from the order book. Gamma's price is a midpoint that can sit far from
 * what you can actually buy (a thin line showed 0.285 while the best ask was 0.56), so each
 * outcome gets the best ask as its price and the dollars offered within 2¢ of it as `depth`.
 */
async function withBooks(detail: GameDetail): Promise<GameDetail> {
  const tokens = detail.markets.flatMap((m) => m.outcomes.map((o) => o.tokenId));
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += 300) chunks.push(tokens.slice(i, i + 300));
  const book = new Map<string, { ask: number; depth: number }>();
  try {
    const results = await Promise.all(
      chunks.map(async (c) => {
        const r = await fetch(`${CLOB_API_URL}/books`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.map((token_id) => ({ token_id }))), cache: "no-store", signal: AbortSignal.timeout(5_000) });
        return r.ok ? ((await r.json()) as { asset_id: string; asks?: { price: string; size: string }[] }[]) : [];
      }),
    );
    for (const b of results.flat()) {
      const asks = (b.asks ?? []).map((a) => ({ p: Number(a.price), s: Number(a.size) })).filter((a) => a.p > 0 && a.s > 0).sort((x, y) => x.p - y.p);
      const best = asks[0];
      if (!best) {
        book.set(b.asset_id, { ask: 0, depth: 0 });
        continue;
      }
      const depth = asks.filter((a) => a.p <= best.p + 0.02).reduce((s, a) => s + a.s * a.p, 0);
      book.set(b.asset_id, { ask: best.p, depth });
    }
  } catch {
    return detail; // Gamma prices stay; the client still quotes live
  }
  // Canary V2 mirrors carry bot midpoints with no relation to their one-sided books; the stale-ask
  // rule would zero the only line the V2 path can be exercised on.
  const canary = detail.canary;
  for (const m of detail.markets) {
    for (const o of m.outcomes) {
      const b = book.get(o.tokenId);
      if (!b) continue;
      // A best ask far above the market's midpoint is a stale one-sided book (someone asking 83¢ for a
      // −5.5 handicap): treat it as nothing for sale rather than show a trap price.
      const stale = !canary && b.ask > 0 && o.price > 0 && b.ask - o.price > 0.2;
      o.depth = stale ? 0 : Math.round(b.depth);
      o.price = b.ask > 0 && !stale ? b.ask : 0; // 0 = nobody selling
    }
  }
  return detail;
}

function periodOf(type: string): Period {
  if (/first_five/.test(type)) return "f5";
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
      const q = /\?: /.test(m.question) ? m.question.split("?: ")[0] + "?" : m.question.includes(": ") ? m.question.split(": ").slice(1).join(": ") : m.question;
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
    .replace(/Will there be a run scored in the first inning\?/i, "¿Carrera en la 1ª entrada?")
    .replace(/Will the game go to extra innings\?/i, "¿Entradas extra?")
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
  return { ...marketCore(m, kind, line), period, group, label, outcomes };
}

function mergeThreeWay(ms: GammaMarket[], t: Teams, period: Period): DetailMarket | null {
  const tw = threeWayOutcomes(ms, t);
  return tw ? { ...mk(tw.first, "moneyline", null, period, "ganador", withPeriod("Ganador", period), tw.outcomes), negRisk: tw.negRisk } : null;
}

// ---------------------------------------------------------------- small helpers (mirrors gamma.ts)
