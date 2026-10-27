"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, Flame, Ticket as TicketIcon } from "lucide-react";
import Avatar from "./Avatar";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { LEAGUE_BY_ID, isLeagueId } from "@/lib/polymarket/leagues";
import { POLYGONSCAN_TX_URL } from "@/lib/polymarket/constants";
import { formatOdds, formatUsd } from "@/lib/polymarket/odds";
import type { FeedItem } from "@/types/social";
import { useMe } from "@/providers/MeProvider";
import { useReact } from "@/hooks/useSocial";
import TailButtons from "./TailButtons";

const STATUS: Record<FeedItem["status"], { label: string; cls: string }> = {
  open: { label: "Abierta", cls: "text-accent-soft border-line bg-[rgba(255,61,23,.08)]" },
  won: { label: "Ganó", cls: "text-win border-[rgba(74,222,128,.3)] bg-[rgba(74,222,128,.08)]" },
  lost: { label: "Perdió", cls: "text-loss border-[rgba(226,75,74,.3)] bg-[rgba(226,75,74,.08)]" },
  void: { label: "Anulada", cls: "text-push border-hairline bg-surface" },
};

const MARKET_LABEL: Record<FeedItem["market"], string> = { ML: "Ganador", Spread: "Hándicap", Total: "Total", BTTS: "Ambos anotan", Prop: "Prop de jugador", Batalla: "Batalla", Otro: "Mercado" };

export default function FeedCard({ item, index = 0, onTicket }: { item: FeedItem; index?: number; onTicket?: (item: FeedItem) => void }) {
  const now = useNow();
  const league = isLeagueId(item.league) ? LEAGUE_BY_ID[item.league] : null;
  const started = item.status === "open" && item.kind !== "battle" && !!item.kickoff && !!now && Date.parse(item.kickoff) <= now.getTime();
  const st =
    item.kind === "battle" && item.status === "void"
      ? { label: "Empate", cls: STATUS.void.cls }
      : started
        ? item.livePrice != null && item.livePrice >= 0.9
          ? { label: "Va ganando", cls: STATUS.won.cls }
          : item.livePrice != null && item.livePrice <= 0.1
            ? { label: "Va perdiendo", cls: STATUS.lost.cls }
            : { label: "En juego", cls: "pill-live border-transparent" }
        : STATUS[item.status];
  const { user } = item;
  const isBattle = item.kind === "battle";

  // 🔥 — optimistic: flip on tap, then trust the server; a refetch that changes the item resets us.
  const router = useRouter();
  const { me } = useMe();
  const react = useReact();
  const seed = `${item.fire}:${item.fired ? 1 : 0}`;
  const [local, setLocal] = useState<{ seed: string; fire: number; fired: boolean } | null>(null);
  const fire = local?.seed === seed ? local.fire : item.fire;
  const fired = local?.seed === seed ? local.fired : !!item.fired;
  async function toggleFire() {
    if (!me) {
      router.push("/entrar");
      return;
    }
    const next = !fired;
    navigator.vibrate?.(8);
    setLocal({ seed, fire: Math.max(0, fire + (next ? 1 : -1)), fired: next });
    const r = await react(item.id, next);
    setLocal(r ? { seed, fire: r.fire, fired: r.fired } : null);
  }
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
            <span className="text-muted-2">· {timeAgo(item.placedAt, now)}</span>
          </div>
          <div className="tnum text-xs text-muted">
            {user.record.w}-{user.record.l}
            {user.record.v ? `-${user.record.v}` : ""} · {user.pnl >= 0 ? "+" : ""}${formatUsd(user.pnl, 0)}
          </div>
        </div>
        <span className={cn("rounded-full border px-2.5 py-1 font-display text-[10px] font-bold uppercase tracking-wide", st.cls)}>{st.label}</span>
      </header>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] uppercase tracking-wider text-muted">
            {isBattle ? "✊✋✌️ " : league ? `${league.emoji} ${league.label} · ` : ""}
            {item.event}
          </div>
          <div className="mt-0.5 truncate font-display text-xl font-extrabold uppercase leading-none">{item.selection}</div>
          <div className="mt-1 truncate text-xs text-muted">{isBattle ? `vs @${item.battle!.opponent.handle}` : MARKET_LABEL[item.market]}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum font-display text-2xl font-extrabold text-accent-soft">{isBattle ? `${item.battle!.scoreMe}-${item.battle!.scoreThem}` : formatOdds(item.odds)}</div>
          <div className="tnum text-xs text-muted">
            ${formatUsd(item.stake, 0)} → <span className="text-ink">${formatUsd(item.payout, 0)}</span>
          </div>
        </div>
      </div>

      <TailButtons item={item} />

      <footer className="mt-3 flex items-center justify-between border-t border-hairline pt-3">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleFire}
            aria-pressed={fired}
            aria-label={fired ? "Quitar fuego" : "Dar fuego"}
            className={cn("flex items-center gap-1.5 text-sm transition-colors active:text-accent", fired ? "text-accent" : "text-muted")}
          >
            <Flame className={cn("h-4 w-4", fired && "fill-current")} /> <span className="tnum">{fire}</span>
          </button>
          {item.proof ? (
            <a href={POLYGONSCAN_TX_URL(item.proof)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-muted-2" title="Ver en Polygon">
              <ExternalLink className="h-3 w-3" /> on-chain
            </a>
          ) : null}
        </div>
        {onTicket ? (
          <button onClick={() => onTicket(item)} className="btn-ghost flex items-center gap-1.5 px-3 py-1 font-display text-[11px] font-bold uppercase tracking-wide">
            <TicketIcon className="h-3.5 w-3.5" /> Boleto
          </button>
        ) : null}
      </footer>
    </article>
  );
}
