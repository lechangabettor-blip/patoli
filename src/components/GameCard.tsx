"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { fetchGameDetail, gameDetailKey } from "@/hooks/useGames";
import { ChevronRight } from "lucide-react";
import type { Game, GameMarket, GameOutcome } from "@/lib/polymarket/gamma";
import type { LiveScore } from "@/lib/scores";
import type { PriceMap } from "@/hooks/useGames";
import { breakdown, formatOdds } from "@/lib/polymarket/odds";
import { isLive, kickoffLabel } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { useBuilderFee } from "@/hooks/useBuilderFee";
import { cn } from "@/lib/cn";

export interface Selection {
  game: Game;
  market: GameMarket;
  outcome: GameOutcome;
  price: number;
  /** Set when the pick was opened from someone's card (Súbaseee = same side, Bájeseee = opposite) */
  source?: { betId: string; side: "tail" | "fade"; handle: string };
}

export default function GameCard({
  game,
  prices,
  score,
  onPick,
  index = 0,
}: {
  game: Game;
  prices: PriceMap | undefined;
  score?: LiveScore;
  onPick: (s: Selection) => void;
  index?: number;
}) {
  const now = useNow();
  const { takerBps } = useBuilderFee();
  // Warm the game page while the card is on screen, so "Todos los mercados" opens instantly.
  const qc = useQueryClient();
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !timer) {
        timer = setTimeout(() => void qc.prefetchQuery({ queryKey: gameDetailKey(game.slug), queryFn: () => fetchGameDetail(game.slug), staleTime: 30_000 }), 400);
      } else if (!e.isIntersecting && timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [game.slug, qc]);
  const ml = game.markets.find((m) => m.kind === "moneyline");
  const spread = game.markets.find((m) => m.kind === "spread");
  const btts = game.markets.find((m) => m.kind === "btts");
  const total = game.markets.find((m) => m.kind === "total");
  const live = !!now && isLive(game.startTime, now);

  const Btn = ({ m, o, stacked = false }: { m: GameMarket; o: GameOutcome; stacked?: boolean }) => {
    const live = prices?.[o.tokenId]?.ask ?? null;
    const p = live ?? (o.price > 0 && o.price < 1 ? o.price : null);
    const dead = p == null || !m.acceptingOrders;
    const odds = p != null ? breakdown(p, m.fee, takerBps).netOdds : null;
    return (
      <button
        disabled={dead}
        onClick={() => p != null && onPick({ game, market: m, outcome: o, price: p })}
        className={cn(
          "flex min-w-0 flex-1 rounded-xl border transition-colors",
          stacked ? "flex-col items-center justify-center gap-0.5 px-2 py-2 text-center" : "items-center justify-between gap-2 px-3 py-2 text-left",
          dead ? "border-hairline bg-surface/40 text-muted-2" : "border-hairline bg-surface active:border-accent active:bg-[rgba(255,61,23,.12)]",
        )}
      >
        <span className={cn("min-w-0 truncate text-[12px] text-muted", stacked && "w-full")}>
          {m.kind === "btts" ? o.label.replace(/^Ambos anotan · /, "") : o.label}
        </span>
        <span className={cn("tnum shrink-0 font-display font-extrabold", stacked ? "text-lg" : "text-base", dead ? "" : "text-accent-soft")}>
          {odds ? formatOdds(odds) : "—"}
        </span>
      </button>
    );
  };

  return (
    <article ref={rootRef} className={cn("card rise overflow-hidden", live && "card-live")} style={{ animationDelay: `${index * 40}ms` }}>
      <div className="px-4 pt-3">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {live ? (
            <span className="pill-live flex items-center gap-1.5 rounded-full px-2 py-0.5 font-display text-[10px] font-extrabold uppercase tracking-wide">
              <span className="pulse-soft inline-block h-1.5 w-1.5 rounded-full bg-violet-soft" /> {score?.state === "post" ? "Final" : "En vivo"}
              {score && score.state !== "post" && score.period ? <span className="tnum font-sans font-semibold normal-case tracking-normal text-white/90">{score.period}{score.clock ? ` ${score.clock}` : ""}</span> : null}
            </span>
          ) : (
            <span className="rounded-full bg-surface px-2 py-0.5">{kickoffLabel(game.startTime, now)}</span>
          )}
          {ml && ml.outcomes.length === 3 ? <span>1X2</span> : null}
        </div>
        <h3 className="mt-1.5 font-display text-[17px] font-extrabold uppercase leading-tight tracking-tight">
          {game.home}
          {score ? <span className="tnum px-1.5 text-accent-soft">{score.first}</span> : null}
          <span className="px-1.5 text-muted">vs</span>
          {score ? <span className="tnum pr-1.5 text-accent-soft">{score.second}</span> : null}
          {game.away}
        </h3>
      </div>
      <div className="space-y-2 px-3 pb-3 pt-2.5">
        {ml ? (
          <div className="flex gap-2">
            {ml.outcomes.map((o) => (
              <Btn key={o.tokenId} m={ml} o={o} stacked={ml.outcomes.length === 3} />
            ))}
          </div>
        ) : null}
        {spread ? (
          <div className="flex gap-2">
            {spread.outcomes.map((o) => (
              <Btn key={o.tokenId} m={spread} o={o} />
            ))}
          </div>
        ) : null}
        {btts ? (
          <div>
            <div className="mb-1 px-1 text-[11px] uppercase tracking-wider text-muted-2">Ambos anotan</div>
            <div className="flex gap-2">
              {btts.outcomes.map((o) => (
                <Btn key={o.tokenId} m={btts} o={o} />
              ))}
            </div>
          </div>
        ) : null}
        {total ? (
          <div className="flex gap-2">
            {total.outcomes.map((o) => (
              <Btn key={o.tokenId} m={total} o={o} />
            ))}
          </div>
        ) : null}
        <Link href={`/deportes/partido/${game.slug}`} className="flex items-center justify-center gap-1 pt-1 font-display text-[11px] font-bold uppercase tracking-wide text-muted">
          Todos los mercados <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  );
}
