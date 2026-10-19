"use client";

import { useState } from "react";
import FeedCard from "./FeedCard";
import { cn } from "@/lib/cn";
import type { FeedItem } from "@/types/social";

type Tab = "deportes" | "batalla";

/** Historial split in two: sports bets (Polymarket) and Arena battles. */
export default function HistoryTabs({ items, loading, onTicket }: { items: FeedItem[]; loading?: boolean; onTicket: (item: FeedItem) => void }) {
  const sports = items.filter((i) => i.kind !== "battle");
  const battles = items.filter((i) => i.kind === "battle");
  const [tab, setTab] = useState<Tab>(sports.length === 0 && battles.length > 0 ? "batalla" : "deportes");
  const list = tab === "deportes" ? sports : battles;

  return (
    <>
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg">Historial</h2>
        <div className="flex rounded-full bg-surface p-0.5">
          {(
            [
              ["deportes", "Deportes", sports.length],
              ["batalla", "Batalla", battles.length],
            ] as [Tab, string, number][]
          ).map(([id, label, n]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "tnum rounded-full px-3 py-1 font-display text-[11px] font-bold uppercase tracking-wide transition-colors",
                tab === id ? "bg-accent text-white" : "text-muted",
              )}
            >
              {label} {n ? <span className={cn("ml-0.5", tab === id ? "text-white/80" : "text-muted-2")}>{n}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 space-y-3">
        {loading ? <div className="skeleton h-24" /> : null}
        {list.map((b, i) => (
          <FeedCard key={b.id} item={b} index={i} onTicket={onTicket} />
        ))}
        {!loading && list.length === 0 ? (
          <p className="card p-4 text-center text-sm text-muted">{tab === "deportes" ? "Sin apuestas deportivas todavía." : "Sin batallas todavía. Ve a Batalla."}</p>
        ) : null}
      </div>
    </>
  );
}
