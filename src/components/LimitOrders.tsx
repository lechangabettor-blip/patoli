"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useCancelOrder, useMarketInfo, useOpenOrders } from "@/hooks/useOrders";
import { formatOdds, formatUsd } from "@/lib/polymarket/odds";
import { shortTeam } from "@/lib/polymarket/teams";
import { cn } from "@/lib/cn";

/**
 * "Órdenes límite" on the owner's Perfil: resting buy orders on Polymarket with a Cancelar.
 * Renders nothing when there are none. A filled order becomes a normal pick via the indexer.
 */
export default function LimitOrders() {
  const orders = useOpenOrders();
  const cancel = useCancelOrder();
  const [busy, setBusy] = useState<string | null>(null);
  const list = (orders.data ?? []).filter((o) => /buy/i.test(o.side));
  const info = useMarketInfo(list.map((o) => o.market));
  if (list.length === 0) return null;

  return (
    <>
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg">Órdenes límite</h2>
        <span className="tnum text-xs text-muted">{list.length}</span>
      </div>
      <div className="card mt-2 divide-y divide-hairline">
        {list.map((o) => {
          const m = info.data?.[o.market.toLowerCase()];
          const price = Number(o.price);
          const size = Number(o.original_size);
          const filled = Number(o.size_matched);
          const left = Math.max(0, size - filled);
          return (
            <div key={o.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] uppercase tracking-wider text-muted">{m?.eventTitle ?? m?.question ?? "Mercado"}</div>
                <div className="truncate font-display text-base font-extrabold uppercase leading-tight">{shortTeam(o.outcome)}</div>
                <div className="tnum text-xs text-muted">
                  {Math.round(price * 100)}¢ · {formatOdds(1 / price)} · ${formatUsd(left * price)} esperando
                  {filled > 0 ? ` · ${formatUsd(filled, 0)} llenadas` : ""}
                </div>
              </div>
              <button
                onClick={async () => {
                  setBusy(o.id);
                  await cancel(o.id);
                  setBusy(null);
                }}
                disabled={busy === o.id}
                className={cn("btn-ghost flex items-center gap-1 px-3 py-1.5 font-display text-[11px] font-bold uppercase", busy === o.id && "opacity-50")}
              >
                <X className="h-3.5 w-3.5" /> Cancelar
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
