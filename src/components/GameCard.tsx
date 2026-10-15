"use client";

import type { Game, GameMarket, GameOutcome } from "@/lib/polymarket/gamma";
import type { PriceMap } from "@/hooks/useGames";
import { breakdown, formatOdds } from "@/lib/polymarket/odds";
import { kickoffLabel } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
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
  const ml = game.markets.find((m) => m.kind === "moneyline");
  const spread = game.markets.find((m) => m.kind === "spread");
  const total = game.markets.find((m) => m.kind === "total");

  const Btn = ({ m, o }: { m: GameMarket; o: GameOutcome }) => {
    const live = prices?.[o.tokenId]?.ask ?? null;
    const p = live ?? (o.price > 0 && o.price < 1 ? o.price : null);
    const dead = p == null || !m.acceptingOrders;
    const odds = p != null ? breakdown(p).netOdds : null;
    return (
      <button
        disabled={dead}
        onClick={() => p != null && onPick({ game, market: m, outcome: o, price: p })}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center justify-center rounded-xl border px-2 py-2 transition-colors",
          dead ? "border-hairline bg-surface/40 text-muted-2" : "border-hairline bg-surface active:border-accent active:bg-[rgba(255,61,23,.12)]",
        )}
      >
        <span className="w-full truncate text-center text-[11px] text-muted">{o.label}</span>
        <span className={cn("tnum font-display text-lg font-extrabold", dead ? "" : "text-accent-soft")}>{odds ? formatOdds(odds) : "—"}</span>
      </button>
    );
  };

  return (
    <article className="card rise overflow-hidden" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="flex items-center justify-between px-4 pt-3">
        <div className="min-w-0">
          <div className="truncate font-display text-base font-extrabold uppercase leading-tight">{game.title}</div>
        </div>
        <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-[11px] text-muted">{kickoffLabel(game.startTime, now)}</span>
      </div>
      <div className="space-y-2 px-3 pb-3 pt-2">
        {ml ? (
          <div className="flex gap-2">
            {ml.outcomes.map((o) => (
              <Btn key={o.tokenId} m={ml} o={o} />
            ))}
          </div>
        ) : null}
        {spread || total ? (
          <div className="flex gap-2">
            {spread?.outcomes.map((o) => <Btn key={o.tokenId} m={spread} o={o} />)}
            {total?.outcomes.map((o) => <Btn key={o.tokenId} m={total} o={o} />)}
          </div>
        ) : null}
      </div>
    </article>
  );
}
