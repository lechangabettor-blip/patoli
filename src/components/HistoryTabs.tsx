"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import FeedCard from "./FeedCard";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/polymarket/odds";
import { POLYGONSCAN_TX_URL } from "@/lib/polymarket/constants";
import type { FeedItem, MoneyRow } from "@/types/social";

type Tab = "deportes" | "batalla" | "dinero";

const MONEY_LABEL: Record<MoneyRow["kind"], string> = {
  deposit: "Depósito",
  withdraw: "Retiro",
  tip_in: "Tip de",
  tip_out: "Tip a",
  arena_in: "De Batalla",
  arena_out: "A Batalla",
  send: "Envío",
};

/**
 * Historial split in two for everyone: sports bets (Polymarket) and Arena battles.
 * A third tab, Dinero (deposits · withdrawals · tips), exists only when the caller passes
 * `money` — the owner's own Perfil, never a public profile.
 */
export default function HistoryTabs({ items, loading, onTicket, money }: { items: FeedItem[]; loading?: boolean; onTicket: (item: FeedItem) => void; money?: { rows: MoneyRow[]; loading: boolean } }) {
  const sports = items.filter((i) => i.kind !== "battle");
  const battles = items.filter((i) => i.kind === "battle");
  const [tab, setTab] = useState<Tab>(sports.length === 0 && battles.length > 0 ? "batalla" : "deportes");
  const list = tab === "deportes" ? sports : battles;
  const tabs: [Tab, string, number][] = [
    ["deportes", "Deportes", sports.length],
    ["batalla", "Batalla", battles.length],
  ];
  if (money) tabs.push(["dinero", "Dinero", money.rows.length]);

  return (
    <>
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-lg">Historial</h2>
        <div className="flex rounded-full bg-surface p-0.5">
          {tabs.map(([id, label, n]) => (
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
      {tab === "dinero" && money ? (
        <div className="card mt-2 divide-y divide-hairline">
          {money.loading && money.rows.length === 0 ? <div className="skeleton m-3 h-16" /> : null}
          {money.rows.map((r) => (
            <a key={r.hash} href={POLYGONSCAN_TX_URL(r.hash)} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {MONEY_LABEL[r.kind]}
                  {r.handle ? <span className="text-accent-soft"> @{r.handle}</span> : null}
                </div>
                <div className="tnum text-xs text-muted">
                  {new Date(r.at).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {r.asset}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={cn("tnum font-display text-base font-extrabold", r.amount > 0 ? "text-win" : "text-ink")}>
                  {r.amount > 0 ? "+" : "−"}${formatUsd(Math.abs(r.amount))}
                </span>
                <ExternalLink className="h-3.5 w-3.5 text-muted-2" />
              </div>
            </a>
          ))}
          {!money.loading && money.rows.length === 0 ? <p className="p-4 text-center text-sm text-muted">Sin movimientos todavía.</p> : null}
        </div>
      ) : (
        <div className="mt-2 space-y-3">
          {loading ? <div className="skeleton h-24" /> : null}
          {list.map((b, i) => (
            <FeedCard key={b.id} item={b} index={i} onTicket={onTicket} />
          ))}
          {!loading && list.length === 0 ? (
            <p className="card p-4 text-center text-sm text-muted">{tab === "deportes" ? "Sin apuestas deportivas todavía." : "Sin batallas todavía. Ve a Batalla."}</p>
          ) : null}
        </div>
      )}
    </>
  );
}
