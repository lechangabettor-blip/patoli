"use client";

import { forwardRef } from "react";
import Avatar from "./Avatar";
import { formatOdds, formatUsd } from "@/lib/polymarket/odds";
import { cn } from "@/lib/cn";

/**
 * El Boleto — Patoli's shareable bet ticket.
 *
 * Shape of a physical stub: perforated tear line, serial strip, barcode made
 * from the on-chain hash. Dark carbon-purple paper, orange ink, Archivo caps.
 * Rendered at 360×640 CSS px and exported at 3× for Stories (1080×1920-ish).
 */

export interface TicketData {
  handle: string;
  avatar: string; // emoji or letter seed
  league: string; // "NFL", "Liga MX"…
  leagueEmoji?: string;
  matchup: string; // "Seahawks vs Broncos"
  selection: string; // "Seahawks -2.5"
  market?: string; // "Hándicap"
  odds: number; // net decimal odds
  stake: number; // USDC
  payout: number; // USDC if wins
  placedAt: string; // ISO
  status?: "open" | "won" | "lost" | "void";
  /** On-chain proof (tx hash or order id); drives the barcode */
  proof?: string;
  kickoff?: string; // ISO
}

const STATUS_LABEL: Record<NonNullable<TicketData["status"]>, string> = {
  open: "EN JUEGO",
  won: "GANADO",
  lost: "PERDIDO",
  void: "ANULADO",
};

function Barcode({ seed }: { seed: string }) {
  // Deterministic bars from the proof hash: width 1–3, gap 1–2.
  const bars: { w: number; g: number }[] = [];
  const s = (seed || "patoli").replace(/^0x/, "");
  for (let i = 0; i < 48; i++) {
    const c = parseInt(s[i % s.length] ?? "7", 16) || 7;
    bars.push({ w: 1 + (c % 3), g: 1 + ((c >> 2) % 2) });
  }
  return (
    <div className="flex h-10 items-end gap-0 overflow-hidden" aria-hidden>
      {bars.map((b, i) => (
        <span key={i} style={{ width: b.w * 2, marginRight: b.g * 2, height: i % 7 === 0 ? "70%" : "100%", background: "currentColor" }} />
      ))}
    </div>
  );
}

const Ticket = forwardRef<HTMLDivElement, { data: TicketData; className?: string }>(function Ticket({ data, className }, ref) {
  const date = new Date(data.placedAt);
  const stamp = date.toLocaleString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", "");
  const serial = (data.proof ?? "").replace(/^0x/, "").slice(0, 12).toUpperCase() || "PATOLI";
  const status = data.status ?? "open";

  return (
    <div
      ref={ref}
      className={cn("relative w-[360px] select-none overflow-hidden font-sans text-white", className)}
      style={{ background: "transparent" }}
    >
      {/* paper */}
      <div
        className="relative overflow-hidden rounded-[28px]"
        style={{
          background:
            "radial-gradient(90% 60% at 50% -10%, rgba(255,61,23,.55), transparent 70%), radial-gradient(60% 40% at 100% 100%, rgba(255,122,92,.18), transparent 70%), linear-gradient(180deg, #2a2a37 0%, #1f1f29 100%)",
          boxShadow: "0 30px 80px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.08)",
        }}
      >
        {/* watermark: patolli cross */}
        <svg viewBox="0 0 512 512" className="absolute -right-16 -top-10 h-64 w-64 opacity-[0.07]" aria-hidden>
          <g fill="none" stroke="#ff7a5c" strokeWidth="28" strokeLinecap="round">
            <path d="M256 80v352M80 256h352M196 120h120M196 392h120M120 196v120M392 196v120" />
          </g>
          <circle cx="256" cy="256" r="34" fill="#ff7a5c" />
        </svg>

        {/* header */}
        <div className="flex items-center justify-between px-6 pt-6">
          <div className="font-display text-2xl font-extrabold uppercase tracking-tight text-[#ff3d17]">Patoli</div>
          <div
            className={cn(
              "rounded-full border px-3 py-1 font-display text-[10px] font-extrabold uppercase tracking-[0.18em]",
              status === "won" && "border-[rgba(74,222,128,.5)] text-[#4ade80]",
              status === "lost" && "border-[rgba(226,75,74,.5)] text-[#e24b4a]",
              status === "void" && "border-white/20 text-[#b9b9c7]",
              status === "open" && "border-[rgba(255,61,23,.5)] text-[#ff7a5c]",
            )}
          >
            {STATUS_LABEL[status]}
          </div>
        </div>

        {/* who */}
        <div className="mt-5 flex items-center gap-3 px-6">
          <Avatar seed={data.avatar} size={44} />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">@{data.handle}</div>
            <div className="text-[11px] uppercase tracking-wider text-[#b9b9c7]">
              {data.leagueEmoji ? `${data.leagueEmoji} ` : ""}
              {data.league} · {data.matchup}
            </div>
          </div>
        </div>

        {/* the pick */}
        <div className="mt-6 px-6">
          <div className="text-[11px] uppercase tracking-[0.2em] text-[#b9b9c7]">{data.market ?? "Pick"}</div>
          <div className="mt-1 font-display text-[34px] font-extrabold uppercase leading-[0.95] tracking-tight">{data.selection}</div>
        </div>

        {/* numbers */}
        <div className="mt-6 grid grid-cols-3 gap-2 px-6">
          <Num k="Momio" v={formatOdds(data.odds)} accent />
          <Num k="Juega" v={`$${formatUsd(data.stake, 0)}`} />
          <Num k={status === "won" ? "Cobró" : "Cobra"} v={`$${formatUsd(data.payout, 2)}`} win={status === "won"} />
        </div>

        {/* tear line */}
        <div className="relative mt-7 flex items-center">
          <span className="absolute -left-4 h-8 w-8 rounded-full" style={{ background: "#1f1f29" }} />
          <span className="mx-6 h-0 flex-1 border-t-2 border-dashed border-white/15" />
          <span className="absolute -right-4 h-8 w-8 rounded-full" style={{ background: "#1f1f29" }} />
        </div>

        {/* stub */}
        <div className="flex items-end justify-between px-6 pb-6 pt-5">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[#b9b9c7]">
              {stamp} · N° {serial}
            </div>
            <div className="mt-2 text-[#ff7a5c]">
              <Barcode seed={data.proof ?? data.handle} />
            </div>
            <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-[#b9b9c7]">{data.proof ? "Verificado on-chain · Polygon" : "Prematch"}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-display text-sm font-extrabold uppercase text-white">patoli.bet</div>
            <div className="text-[10px] text-[#b9b9c7]">Cualquiera opina.</div>
            <div className="text-[10px] text-[#b9b9c7]">Nosotros apostamos.</div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default Ticket;

function Num({ k, v, accent, win }: { k: string; v: string; accent?: boolean; win?: boolean }) {
  return (
    <div className="rounded-2xl px-3 py-2.5" style={{ background: "rgba(255,255,255,.05)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.06)" }}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-[#b9b9c7]">{k}</div>
      <div className={cn("tnum mt-0.5 font-display text-xl font-extrabold", accent && "text-[#ff7a5c]", win && "text-[#4ade80]")}>{v}</div>
    </div>
  );
}
