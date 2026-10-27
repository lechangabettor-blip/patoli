"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingDown, TrendingUp } from "lucide-react";
import BetSheet from "./BetSheet";
import type { Selection } from "./GameCard";
import { fetchGameDetail, gameDetailKey } from "@/hooks/useGames";
import { useMe } from "@/providers/MeProvider";
import { cn } from "@/lib/cn";
import type { FeedItem } from "@/types/social";

type Side = "tail" | "fade";

/**
 * SÚBASEEE / BÁJESEEE on someone's open sports pick: opens the regular bet sheet on the same side
 * (tail) or the opposite token of the same Polymarket market (fade). On a soccer 1X2 pick the fade
 * is the No side, i.e. "Rival o Empate", so it is an exact hedge with the same liquidity.
 * The count under each button = people who really placed that bet from this card.
 */
export default function TailButtons({ item }: { item: FeedItem }) {
  const { me } = useMe();
  const qc = useQueryClient();
  const [sel, setSel] = useState<Selection | null>(null);
  const [busy, setBusy] = useState<Side | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (item.kind === "battle" || item.status !== "open" || !item.tokenId || !item.eventSlug) return null;
  if (me && me.handle === item.user.handle) return null;
  const slug = item.eventSlug;

  async function tap(side: Side) {
    if (busy) return;
    setErr(null);
    setBusy(side);
    navigator.vibrate?.(8);
    try {
      const target = side === "tail" ? item.tokenId : item.fadeTokenId;
      if (!target) throw new Error("Este pick no tiene lado contrario");
      const detail = await qc.fetchQuery({ queryKey: gameDetailKey(slug), queryFn: () => fetchGameDetail(slug), staleTime: 30_000 });
      const hit = detail?.markets.flatMap((m) => m.outcomes.map((o) => ({ m, o }))).find(({ o }) => o.tokenId === target);
      if (!detail || !hit || !hit.m.acceptingOrders) throw new Error("Mercado cerrado");
      if (!(hit.o.price > 0) || hit.o.price >= 0.99) throw new Error("Sin liquidez en este momento");
      setSel({ game: { ...detail.game, markets: [] }, market: hit.m, outcome: hit.o, price: hit.o.price, source: { betId: item.id, side, handle: item.user.handle } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo abrir");
      setTimeout(() => setErr(null), 3000);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={() => tap("tail")}
          disabled={!!busy}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-xl border py-2 font-display text-[12px] font-extrabold uppercase tracking-wide transition-[transform,opacity] active:scale-[.98] disabled:opacity-60",
            item.tailed ? "border-accent bg-accent text-white" : "border-[rgba(255,61,23,.35)] bg-[rgba(255,61,23,.08)] text-accent-soft",
          )}
        >
          <TrendingUp className="h-3.5 w-3.5" /> Súbaseee
          {item.tails > 0 ? <span className={cn("tnum", item.tailed ? "text-white/80" : "text-accent-soft/70")}>{item.tails}</span> : null}
        </button>
        <button
          onClick={() => tap("fade")}
          disabled={!!busy || !item.fadeTokenId}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-xl border py-2 font-display text-[12px] font-extrabold uppercase tracking-wide transition-[transform,opacity] active:scale-[.98] disabled:opacity-40",
            item.faded ? "border-violet bg-violet text-white" : "border-[rgba(157,123,255,.4)] bg-[rgba(75,0,130,.22)] text-violet-soft",
          )}
        >
          <TrendingDown className="h-3.5 w-3.5" /> Bájeseee
          {item.fades > 0 ? <span className={cn("tnum", item.faded ? "text-white/80" : "text-violet-soft/70")}>{item.fades}</span> : null}
        </button>
      </div>
      {err ? <p className="mt-1.5 text-center text-[11px] text-loss">{err}</p> : null}
      <BetSheet selection={sel} onClose={() => setSel(null)} />
    </>
  );
}
