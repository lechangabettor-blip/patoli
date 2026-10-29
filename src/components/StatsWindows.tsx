"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/polymarket/odds";
import type { PublicProfile, StatsWindow, WindowKey } from "@/types/social";

const WINDOWS: { key: WindowKey; label: string; hint: string }[] = [
  { key: "d7", label: "Semana", hint: "últimos 7 días" },
  { key: "d30", label: "Mes", hint: "últimos 30 días" },
  { key: "all", label: "Todo", hint: "desde siempre" },
];

const signed = (n: number, digits = 1, suffix = "") => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(digits)}${suffix}`;
const tone = (n: number) => (n > 0 ? "text-win" : n < 0 ? "text-loss" : "");

/** Open on the first window with something in it (week → month → all time) instead of an empty 0-0 week. */
function firstActive(p: PublicProfile): WindowKey {
  const w = p.windows;
  if (!w) return "d7";
  for (const k of ["d7", "d30", "all"] as WindowKey[]) {
    const s = w[k].sports;
    const b = w[k].battles;
    if (s.w + s.l + s.v + b.w + b.l + b.d > 0) return k;
  }
  return "d7";
}

/**
 * Sports record and Batalla record over a rolling window (7 days, 30 days, all time), counted by
 * the moment each bet or battle settled. Sports and Batalla are two separate records, never mixed.
 * Falls back to the all-time numbers on the profile when windows are not present (lists).
 */
export default function StatsWindows({ profile, compact = false }: { profile: PublicProfile; compact?: boolean }) {
  const [key, setKey] = useState<WindowKey>(() => firstActive(profile));
  const w: StatsWindow = profile.windows?.[key] ?? {
    sports: { w: profile.record.w, l: profile.record.l, v: profile.record.v, units: profile.units, pnl: profile.pnl, staked: profile.staked, roi: profile.roi },
    battles: profile.battles,
  };
  const s = w.sports;
  const b = w.battles;
  const current = WINDOWS.find((x) => x.key === key)!;

  return (
    <div className={cn(compact ? "mt-3" : "")}>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex gap-1 rounded-full bg-surface p-0.5">
          {WINDOWS.map((x) => (
            <button
              key={x.key}
              onClick={() => setKey(x.key)}
              className={cn(
                "rounded-full px-3 py-1 font-display text-[10px] font-bold uppercase tracking-wide transition-colors",
                key === x.key ? "bg-accent text-white" : "text-muted",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted-2">{current.hint}</span>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
        <Tile k="Récord" v={`${s.w}-${s.l}${s.v ? `-${s.v}` : ""}`} />
        <Tile k="Unidades" v={signed(s.units, 1, "u")} cls={tone(s.units)} />
        <Tile k="P&L" v={`${s.pnl > 0 ? "+" : s.pnl < 0 ? "-" : ""}$${formatUsd(Math.abs(s.pnl), 0)}`} cls={tone(s.pnl)} />
        <Tile k="ROI" v={signed(s.roi, 1, "%")} cls={tone(s.roi)} />
      </div>

      <div className="tnum mt-2 flex items-center justify-between rounded-xl bg-surface/60 px-3 py-2 text-xs">
        <span className="text-muted">✊ Batalla</span>
        <span>
          <b className="text-ink">
            {b.w}-{b.l}
            {b.d ? `-${b.d}` : ""}
          </b>
          <span className={cn("ml-2", tone(b.pnl))}>
            {b.pnl > 0 ? "+" : b.pnl < 0 ? "-" : ""}${formatUsd(Math.abs(b.pnl), 0)}
          </span>
        </span>
      </div>
    </div>
  );
}

function Tile({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="rounded-xl bg-surface/60 px-1 py-2.5">
      <div className={cn("tnum font-display text-base font-extrabold", cls)}>{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
    </div>
  );
}
