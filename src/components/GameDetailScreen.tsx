"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft } from "lucide-react";
import TopBar from "./TopBar";
import BetSheet from "./BetSheet";
import type { Selection } from "./GameCard";
import type { Game, GameMarket, GameOutcome, Period } from "@/lib/polymarket/gamma";
import type { DetailMarket } from "@/lib/polymarket/game-detail";
import { LEAGUE_BY_ID } from "@/lib/polymarket/leagues";
import { useGameDetail, usePrices, useScores, type PriceMap } from "@/hooks/useGames";
import { useBuilderFee } from "@/hooks/useBuilderFee";
import { useNow } from "@/hooks/useNow";
import { breakdown, formatOdds } from "@/lib/polymarket/odds";
import { isLive, kickoffLabel } from "@/lib/format";
import { cn } from "@/lib/cn";

/* ───────────────────────────── grouping ───────────────────────────── */

type Chip = { id: string; label: string; test: (m: DetailMarket) => boolean };

const PERIOD_LABEL: Record<Period, string> = { full: "", "1h": "1ª mitad", "2h": "2ª mitad", q1: "1er cuarto", q2: "2º cuarto", q3: "3er cuarto", q4: "4º cuarto" };
const PERIOD_ORDER: Record<Period, number> = { full: 0, "1h": 1, "2h": 2, q1: 3, q2: 4, q3: 5, q4: 6 };
const GROUP_ORDER: Record<DetailMarket["group"], number> = { ganador: 0, handicap: 1, total: 2, btts: 3, equipo: 4, props: 6, otros: 7 };
const STAT_ORDER: Record<string, number> = { points: 0, rebounds: 1, assists: 2, threes: 3, steals: 4, blocks: 5 };

const CHIPS: Chip[] = [
  { id: "todos", label: "Todos", test: () => true },
  { id: "ganador", label: "Ganador", test: (m) => m.group === "ganador" },
  { id: "handicap", label: "Hándicap", test: (m) => m.group === "handicap" },
  { id: "total", label: "Totales", test: (m) => m.group === "total" },
  { id: "btts", label: "Ambos anotan", test: (m) => m.group === "btts" },
  { id: "equipo", label: "Por equipo", test: (m) => m.group === "equipo" },
  { id: "1h", label: "1ª mitad", test: (m) => m.period === "1h" },
  { id: "2h", label: "2ª mitad", test: (m) => m.period === "2h" },
  { id: "cuartos", label: "Cuartos", test: (m) => /^q[1-4]$/.test(m.period) },
  { id: "props", label: "Props", test: (m) => m.group === "props" },
  { id: "otros", label: "Otros", test: (m) => m.group === "otros" },
];

interface Section {
  key: string;
  title: string;
  layout: "buttons" | "ladder" | "players" | "list";
  group: DetailMarket["group"];
  period: Period;
  markets: DetailMarket[];
  /** Column headers for a ladder */
  columns?: [string, string];
  /** The line the board shows (most liquid) */
  mainId?: string;
  defaultOpen: boolean;
}

function buildSections(markets: DetailMarket[]): Section[] {
  const map = new Map<string, Section>();
  for (const m of markets) {
    const sub = m.group === "props" ? (m.stat ?? "") : m.group === "equipo" ? (m.subject ?? "") : m.group === "otros" ? "otros" : "";
    const key = `${m.group}|${m.period}|${sub}`;
    let s = map.get(key);
    if (!s) {
      const layout: Section["layout"] = m.kind === "spread" || m.kind === "total" || m.kind === "team_total" ? "ladder" : m.kind === "prop" ? "players" : m.group === "otros" ? "list" : "buttons";
      let title = m.label;
      if (m.kind === "prop") title = `${m.label.split(" · ")[0]}${m.period === "full" ? "" : ` · ${PERIOD_LABEL[m.period]}`}`;
      if (m.group === "otros") title = m.period === "full" ? "Otros mercados" : `Otros · ${PERIOD_LABEL[m.period]}`;
      s = { key, title, layout, group: m.group, period: m.period, markets: [], defaultOpen: m.period === "full" && (m.group === "ganador" || m.group === "handicap" || m.group === "total") };
      map.set(key, s);
    }
    s.markets.push(m);
  }
  const out = [...map.values()];
  for (const s of out) {
    if (s.layout === "ladder") {
      s.markets.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      const first = s.markets[0];
      s.columns = s.markets[0].kind === "spread" ? [teamOf(first.outcomes[0].label), teamOf(first.outcomes[1].label)] : ["Más", "Menos"];
      s.mainId = s.markets.reduce((best, m) => (m.liquidity > best.liquidity ? m : best), s.markets[0]).id;
    }
    if (s.layout === "players") s.markets.sort((a, b) => (a.subject ?? "").localeCompare(b.subject ?? "") || (a.line ?? 0) - (b.line ?? 0));
  }
  out.sort((a, b) => {
    const pa = PERIOD_ORDER[a.period] === 0 ? 0 : 1;
    const pb = PERIOD_ORDER[b.period] === 0 ? 0 : 1;
    if (pa !== pb) return pa - pb; // full game first, then the rest
    if (a.group === "props" && b.group !== "props") return 1;
    if (b.group === "props" && a.group !== "props") return -1;
    return PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period] || GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || (STAT_ORDER[a.markets[0].stat ?? ""] ?? 9) - (STAT_ORDER[b.markets[0].stat ?? ""] ?? 9) || a.title.localeCompare(b.title);
  });
  return out;
}

const teamOf = (label: string) => label.replace(/\s[+-][\d.]+$/, "");

/* ───────────────────────────── screen ───────────────────────────── */

export default function GameDetailScreen({ slug }: { slug: string }) {
  const q = useGameDetail(slug);
  const detail = q.data;
  const now = useNow();
  const { takerBps } = useBuilderFee();
  const [chip, setChip] = useState("todos");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<Selection | null>(null);

  const sections = useMemo(() => (detail ? buildSections(detail.markets) : []), [detail]);
  const chips = useMemo(() => CHIPS.filter((c) => c.id === "todos" || (detail?.markets ?? []).some(c.test)), [detail]);
  const active = CHIPS.find((c) => c.id === chip) ?? CHIPS[0];
  const visible = useMemo(() => (chip === "todos" ? sections : sections.map((s) => ({ ...s, markets: s.markets.filter(active.test) })).filter((s) => s.markets.length > 0)), [sections, chip, active]);
  const isOpen = (s: Section) => toggled[s.key] ?? (chip !== "todos" || s.defaultOpen);

  const live = !!detail && !!now && isLive(detail.game.startTime, now);
  const scores = useScores(detail?.game.league ?? "nfl", live);
  const score = detail ? scores.data?.[detail.game.slug] : undefined;

  const tokenIds = useMemo(() => visible.filter(isOpen).flatMap((s) => s.markets.flatMap((m) => m.outcomes.map((o) => o.tokenId))).slice(0, 200), [visible, toggled, chip]); // eslint-disable-line react-hooks/exhaustive-deps
  const prices = usePrices(tokenIds, live ? 2_000 : 5_000);

  const game: Game | null = detail ? { ...detail.game, markets: [] } : null;
  const league = detail ? LEAGUE_BY_ID[detail.game.league] : null;

  return (
    <>
      <TopBar title="Partido" />
      <div className="px-4 pt-3">
        <Link href={detail ? `/deportes?liga=${detail.game.league}` : "/deportes"} className="inline-flex items-center gap-1 text-xs text-muted">
          <ChevronLeft className="h-4 w-4" /> {league ? `${league.emoji} ${league.label}` : "Deportes"}
        </Link>
      </div>

      {q.isLoading ? (
        <div className="space-y-3 px-4 pt-3">
          <div className="skeleton h-20" />
          <div className="skeleton h-10" />
          <div className="skeleton h-40" />
        </div>
      ) : !detail || !game ? (
        <div className="card mx-4 mt-3 p-6 text-center">
          <h2 className="text-xl">Sin mercados</h2>
          <p className="mt-2 text-sm text-muted">Polymarket no tiene este partido abierto ahora mismo.</p>
        </div>
      ) : (
        <>
          <header className="px-4 pt-3">
            <div className="flex items-center gap-2 text-[11px] text-muted">
              {live ? (
                <span className="pill-live flex items-center gap-1.5 rounded-full px-2 py-0.5 font-display text-[10px] font-extrabold uppercase tracking-wide">
                  <span className="pulse-soft inline-block h-1.5 w-1.5 rounded-full bg-violet-soft" /> {score?.state === "post" ? "Final" : "En vivo"}
                  {score && score.state !== "post" && score.period ? <span className="tnum font-sans font-semibold normal-case tracking-normal text-white/90">{score.period}{score.clock ? ` ${score.clock}` : ""}</span> : null}
                </span>
              ) : (
                <span className="rounded-full bg-surface px-2 py-0.5">{kickoffLabel(detail.game.startTime, now)}</span>
              )}
              <span className="text-muted-2">{detail.markets.length} mercados</span>
            </div>
            <h1 className="mt-1.5 font-display text-[20px] font-extrabold uppercase leading-tight tracking-tight">
              {detail.game.home}{" "}
              {score ? <span className="tnum text-accent-soft">{score.first} </span> : null}
              <span className="text-muted">vs</span>{" "}
              {score ? <span className="tnum text-accent-soft">{score.second} </span> : null}
              {detail.game.away}
            </h1>
          </header>

          <div className="sticky z-20 mt-3 border-b border-hairline bg-[rgba(31,31,41,0.85)] backdrop-blur-xl" style={{ top: "var(--top-h)" }}>
            <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-2.5">
              {chips.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChip(c.id)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1.5 font-display text-[11px] font-bold uppercase tracking-wide transition-colors",
                    chip === c.id ? "border-accent bg-accent text-white" : "border-hairline bg-surface text-muted",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <section className="space-y-3 px-4 pt-3">
            {visible.map((s) => {
              const open = isOpen(s);
              return (
                <article key={s.key} className="card overflow-hidden">
                  <button onClick={() => setToggled((t) => ({ ...t, [s.key]: !open }))} className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open}>
                    <span className="font-display text-[13px] font-extrabold uppercase tracking-wide">{s.title}</span>
                    <span className="flex items-center gap-2 text-[11px] text-muted-2">
                      {s.markets.length > 1 ? `${s.markets.length}` : ""}
                      <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
                    </span>
                  </button>
                  {open ? (
                    <div className="px-3 pb-3">
                      <SectionBody s={s} game={game} prices={prices.data} takerBps={takerBps} onPick={setSel} />
                    </div>
                  ) : null}
                </article>
              );
            })}
            <p className="pb-2 pt-2 text-center text-[11px] text-muted-2">Precios en vivo de Polymarket · tu precio ya incluye comisiones</p>
          </section>
        </>
      )}

      <BetSheet selection={sel} onClose={() => setSel(null)} />
    </>
  );
}

/* ───────────────────────────── bodies ───────────────────────────── */

function SectionBody({ s, game, prices, takerBps, onPick }: { s: Section; game: Game; prices: PriceMap | undefined; takerBps: number; onPick: (sel: Selection) => void }) {
  const Btn = ({ m, o, main = false, compact = false }: { m: GameMarket; o: GameOutcome; main?: boolean; compact?: boolean }) => {
    const liveP = prices?.[o.tokenId]?.ask ?? null;
    const p = liveP ?? (o.price > 0 && o.price < 1 ? o.price : null);
    const dead = p == null || !m.acceptingOrders;
    const odds = p != null ? breakdown(p, m.fee, takerBps).netOdds : null;
    return (
      <button
        disabled={dead}
        onClick={() => p != null && onPick({ game, market: m, outcome: o, price: p })}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border px-3 text-left transition-colors",
          compact ? "py-1.5" : "py-2",
          dead ? "border-hairline bg-surface/40 text-muted-2" : main ? "border-[rgba(255,61,23,.45)] bg-surface active:bg-[rgba(255,61,23,.12)]" : "border-hairline bg-surface active:border-accent active:bg-[rgba(255,61,23,.12)]",
        )}
      >
        <span className="min-w-0 truncate text-[12px] text-muted">{o.label}</span>
        <span className={cn("tnum shrink-0 font-display font-extrabold", compact ? "text-[15px]" : "text-base", dead ? "" : "text-accent-soft")}>{odds ? formatOdds(odds) : "—"}</span>
      </button>
    );
  };

  if (s.layout === "buttons") {
    return (
      <div className="space-y-2">
        {s.markets.map((m) => (
          <div key={m.id} className="flex gap-2">
            {m.outcomes.map((o) => (
              <Btn key={o.tokenId} m={m} o={o} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (s.layout === "ladder") {
    return (
      <div>
        <div className="mb-1 grid grid-cols-2 gap-2 px-1 text-center text-[11px] uppercase tracking-wider text-muted-2">
          <span className="truncate">{s.columns?.[0]}</span>
          <span className="truncate">{s.columns?.[1]}</span>
        </div>
        <div className="space-y-1.5">
          {s.markets.map((m) => (
            <div key={m.id} className="grid grid-cols-2 gap-2">
              {m.outcomes.slice(0, 2).map((o) => (
                <Btn key={o.tokenId} m={m} o={{ ...o, label: ladderLabel(o.label, m) }} main={m.id === s.mainId} compact />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (s.layout === "players") {
    return (
      <div className="space-y-1.5">
        {s.markets.map((m) => (
          <div key={m.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
            <span className="min-w-0 truncate text-[12px]">{m.subject}</span>
            {m.outcomes.slice(0, 2).map((o) => (
              <div key={o.tokenId} className="w-[104px]">
                <Btn m={m} o={o} compact />
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // list: one labelled row per market
  return (
    <div className="space-y-2">
      {s.markets.map((m) => (
        <div key={m.id}>
          <div className="mb-1 px-1 text-[11px] text-muted">{m.label}</div>
          <div className="flex gap-2">
            {m.outcomes.map((o) => (
              <Btn key={o.tokenId} m={m} o={o} compact />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** In a ladder the column header already names the team / side; the cell shows only the line. */
function ladderLabel(label: string, m: GameMarket): string {
  if (m.kind === "spread") return label.match(/[+-][\d.]+$/)?.[0] ?? label;
  return label.replace(/^(Más|Menos)\s*/, "");
}
