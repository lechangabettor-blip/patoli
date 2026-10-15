"use client";

import Link from "next/link";
import { Flame } from "lucide-react";
import Avatar from "./Avatar";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { LEAGUE_BY_ID } from "@/lib/polymarket/leagues";
import type { DemoBet, DemoUser } from "@/data/demo";

const STATUS: Record<DemoBet["status"], { label: string; cls: string }> = {
  open: { label: "Abierta", cls: "text-accent-soft border-line bg-[rgba(255,61,23,.08)]" },
  won: { label: "Ganó", cls: "text-win border-[rgba(74,222,128,.3)] bg-[rgba(74,222,128,.08)]" },
  lost: { label: "Perdió", cls: "text-loss border-[rgba(226,75,74,.3)] bg-[rgba(226,75,74,.08)]" },
  void: { label: "Anulada", cls: "text-push border-hairline bg-surface" },
};

export default function FeedCard({ bet, user, index = 0 }: { bet: DemoBet; user: DemoUser; index?: number }) {
  const now = useNow();
  const league = LEAGUE_BY_ID[bet.league];
  const st = STATUS[bet.status];
  const payout = bet.stake * bet.odds;
  return (
    <article className="card rise p-4" style={{ animationDelay: `${index * 50}ms` }}>
      <header className="flex items-center gap-3">
        <Link href={`/u/${user.handle}`}>
          <Avatar seed={user.avatar} size={40} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link href={`/u/${user.handle}`} className="truncate font-semibold">
              @{user.handle}
            </Link>
            {user.verified ? <span title="Verificado" className="text-accent">✦</span> : null}
            <span className="text-muted-2">· {timeAgo(bet.placedAt, now)}</span>
          </div>
          <div className="tnum text-xs text-muted">
            {user.record.w}-{user.record.l}
            {user.record.v ? `-${user.record.v}` : ""} · {user.units >= 0 ? "+" : ""}
            {user.units.toFixed(1)}u
          </div>
        </div>
        <span className={cn("rounded-full border px-2.5 py-1 font-display text-[10px] font-bold uppercase tracking-wide", st.cls)}>{st.label}</span>
      </header>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-muted">
            {league.emoji} {league.label} · {bet.event}
          </div>
          <div className="mt-0.5 truncate font-display text-xl font-extrabold uppercase leading-none">{bet.selection}</div>
          <div className="mt-1 text-xs text-muted">{bet.market === "ML" ? "Ganador" : bet.market === "Spread" ? "Hándicap" : "Total"}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum font-display text-2xl font-extrabold text-accent-soft">{bet.odds.toFixed(2)}</div>
          <div className="tnum text-xs text-muted">
            ${bet.stake} → <span className="text-ink">${payout.toFixed(0)}</span>
          </div>
        </div>
      </div>

      <footer className="mt-3 flex items-center justify-between border-t border-hairline pt-3">
        <button className="flex items-center gap-1.5 text-sm text-muted transition-colors active:text-accent" aria-label="Reaccionar">
          <Flame className="h-4 w-4" /> <span className="tnum">{bet.fire}</span>
        </button>
        <button className="btn-ghost px-3 py-1 font-display text-[11px] font-bold uppercase tracking-wide">Copiar pick</button>
      </footer>
    </article>
  );
}
