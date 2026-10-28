"use client";

import { breakdown, formatOdds, type FeeSchedule } from "@/lib/polymarket/odds";
import { cn } from "@/lib/cn";
import type { BookTop } from "@/hooks/useOrders";

/**
 * The top of the book as four tappable rows: two asks (what you can buy right now) above two
 * bids (where buyers are waiting). The spread is usually one cent, so the user simply picks a
 * row: an ask fills now, a bid rests until someone sells there. Each row shows the price in
 * cents, the decimal odds net of fees for that case, and the shares resting at the level.
 */
export default function LimitBook({
  book,
  selected,
  onSelect,
  fee,
  takerBps,
  makerBps,
  loading,
}: {
  book: BookTop | undefined;
  selected: number | null;
  onSelect: (price: number) => void;
  fee: FeeSchedule;
  takerBps: number;
  makerBps: number;
  loading: boolean;
}) {
  if (!book) return <div className={cn("mt-4 h-[164px] rounded-xl bg-surface/60", loading && "skeleton")} />;
  const rows = [
    ...book.asks.slice().reverse().map((l) => ({ ...l, side: "ask" as const })),
    ...book.bids.map((l) => ({ ...l, side: "bid" as const })),
  ];
  if (rows.length === 0) return <p className="mt-4 rounded-xl bg-surface/60 p-3 text-center text-xs text-muted">Nadie está vendiendo ni comprando este lado ahora mismo.</p>;
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-hairline">
      {rows.map((r, i) => {
        const taker = r.side === "ask";
        const odds = breakdown(r.price, fee, taker ? takerBps : makerBps, !taker).netOdds;
        const on = selected != null && Math.abs(selected - r.price) < 1e-6;
        return (
          <button
            key={`${r.side}-${r.price}`}
            onClick={() => onSelect(r.price)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
              i > 0 && "border-t border-hairline",
              r.side === "ask" && i === book.asks.length - 1 && "border-b-2 border-b-line",
              on ? "bg-[rgba(255,61,23,.10)]" : "bg-surface/40",
            )}
            aria-pressed={on}
          >
            <span className={cn("w-8 font-display text-[10px] font-extrabold uppercase tracking-wide", r.side === "ask" ? "text-loss" : "text-win")}>{r.side}</span>
            <span className={cn("tnum w-12 font-display text-lg font-extrabold", on ? "text-accent-soft" : "text-ink")}>{Math.round(r.price * 100)}¢</span>
            <span className="tnum font-display text-base font-extrabold text-accent-soft">{formatOdds(odds)}</span>
            <span className="tnum ml-auto text-xs text-muted">{Math.round(r.size).toLocaleString("es-MX")} shares</span>
          </button>
        );
      })}
    </div>
  );
}
