"use client";

import type { Game, GameMarket, GameOutcome } from "@/lib/polymarket/gamma";
import type { PriceMap } from "@/hooks/useGames";
import { breakdown, formatOdds } from "@/lib/polymarket/odds";
import { kickoffLabel } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { useBuilderFee } from "@/hooks/useBuilderFee";
import { cn } from "@/lib/cn";

export interface Selection {
  game: Game;
  market: GameMarket;
  outcome: GameOutcome;
  price: number;
}

export default function GameCard({
  game,
  prices,
  onPick,
  index = 0,
}: {
  game: Game;
  prices: PriceMap | undefined;
  onPick: (s: Selection) => void;
  index?: number;
}) {
  const now = useNow();
  const { takerBps } = useBuilderFee();
  const ml = game.markets.find((m) => m.kind === "moneyline");
  const spread = game.markets.find((m) => m.kind === "spread");
  const total = game.markets.find((m) => m.kind === "total");

  const Btn = ({ m, o, stacked = false }: { m: GameMarket; o: GameOutcome; stacked?: boolean }) => {
    const live = prices?.[o.tokenId]?.ask ?? null;
    const p = live ?? (o.price > 0 && o.price < 1 ? o.price : null);
    const dead = p == null || !m.acceptingOrders;
    const odds = p != null ? breakdown(p, undefined, takerBps).netOdds : null;
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
        <span className={cn("min-w-0 truncate text-[12px] text-muted", stacked && "w-full")}>{o.label}</span>
        <span className={cn("tnum shrink-0 font-display font-extrabold", stacked ? "text-lg" : "text-base", dead ? "" : "text-accent-soft")}>
          {odds ? formatOdds(odds) : "—"}
        </span>
      </button>
    );
  };

  return (
    <article className="card rise overflow-hidden" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="px-4 pt-3">
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <span className="rounded-full bg-surface px-2 py-0.5">{kickoffLabel(game.startTime, now)}</span>
          {ml && ml.outcomes.length === 3 ? <span>1X2</span> : null}
        </div>
        <h3 className="mt-1.5 font-display text-[17px] font-extrabold uppercase leading-tight tracking-tight">
          {game.home}
          <span className="px-1.5 text-muted">vs</span>
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
        {total ? (
          <div className="flex gap-2">
            {total.outcomes.map((o) => (
              <Btn key={o.tokenId} m={total} o={o} />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
