"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Copy, ExternalLink, LogOut, ShieldCheck, Ticket as TicketIcon } from "lucide-react";
import TopBar from "./TopBar";
import Avatar from "./Avatar";
import Logo from "./Logo";
import Sheet from "./Sheet";
import TicketShare from "./TicketShare";
import WithdrawSheet from "./WithdrawSheet";
import EditProfileSheet from "./EditProfileSheet";
import type { TicketData } from "./Ticket";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { useMe } from "@/providers/MeProvider";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsd } from "@/lib/polymarket/odds";
import { shortAddress, signed } from "@/lib/format";
import { POLYMARKET_PROFILE_URL } from "@/lib/polymarket/constants";
import { SESSION_STEP_LABEL } from "@/lib/polymarket/session";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";

interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl: number;
  realizedPnl: number;
  redeemable: boolean;
  negativeRisk?: boolean;
  endDate?: string;
  slug?: string;
}

/** Cost basis in USDC; the data API can lag avgPrice right after a fill. */
const costOf = (p: Position) => (p.initialValue && p.initialValue > 0 ? p.initialValue : p.size * (p.avgPrice || 0));

export default function ProfileScreen() {
  const { status, email, eoaAddress, logout, isDemo } = useWallet();
  const { me } = useMe();
  const { walletAddress, legacySafeAddress, isReady, step, setupTrading, error, wrapUsdc, migrateFromSafe, redeem } = useTrading();
  const { balance, pendingUsdc, pendingUsdcRaw, legacyUsdc, legacyUsdcRaw, refetch } = useUsdcBalance();
  const qc = useQueryClient();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [showFullAddress, setShowFullAddress] = useState(false);
  const [busy, setBusy] = useState<"wrap" | "migrate" | "redeem" | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [ticket, setTicket] = useState<TicketData | null>(null);

  const builder = useQuery({
    queryKey: ["builder-configured"],
    staleTime: 60_000,
    queryFn: async (): Promise<{ configured: boolean }> => {
      const r = await fetch("/api/polymarket/sign");
      return r.ok ? r.json() : { configured: false };
    },
  });
  const builderReady = builder.data?.configured ?? true;

  const positions = useQuery({
    queryKey: ["positions", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval: 20_000,
    queryFn: async (): Promise<Position[]> => {
      const r = await fetch(`/api/positions?user=${walletAddress}`);
      return r.ok ? r.json() : [];
    },
  });

  async function run(kind: "wrap" | "migrate" | "redeem") {
    setOpError(null);
    setBusy(kind);
    try {
      if (kind === "wrap") await wrapUsdc(pendingUsdcRaw);
      else if (kind === "migrate") await migrateFromSafe(legacyUsdcRaw);
      else {
        const targets = redeemables.map((p) => ({ conditionId: p.conditionId as `0x${string}`, negRisk: !!p.negativeRisk }));
        // one call per market even if several outcomes are held
        const seen = new Set<string>();
        await redeem(targets.filter((t) => (seen.has(t.conditionId) ? false : (seen.add(t.conditionId), true))));
        qc.invalidateQueries({ queryKey: ["positions"] });
      }
      await refetch();
      qc.invalidateQueries({ queryKey: ["balances"] });
    } catch (e) {
      setOpError(e instanceof Error ? e.message : "No se pudo completar");
    } finally {
      setBusy(null);
    }
  }

  if (status === "loading") {
    return (
      <>
        <TopBar title="Perfil" />
        <div className="space-y-3 px-4 pt-4">
          <div className="skeleton h-24" />
          <div className="skeleton h-16" />
        </div>
      </>
    );
  }

  if (status !== "connected") {
    return (
      <>
        <TopBar title="Perfil" />
        <section className="px-4 pt-8 text-center">
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-surface">
            <Logo size={56} word={false} />
          </div>
          <h1 className="mt-4 text-3xl">
            Tu récord,
            <br />
            <span className="text-accent">verificable</span>
          </h1>
          <p className="mx-auto mt-2 max-w-[30ch] text-sm text-muted">Cada apuesta queda en la blockchain. Nadie puede inventarse un historial, ni tú ni nadie.</p>
          <Link href="/entrar" className="btn-accent mt-6 inline-block w-full py-3.5 text-sm">
            Entrar o crear cuenta
          </Link>
          {isDemo ? <p className="mt-3 text-[11px] text-muted-2">Modo demo: configura NEXT_PUBLIC_MAGIC_API_KEY para activar el login.</p> : null}
        </section>
      </>
    );
  }

  const handle = me?.handle ?? ((email ?? "usuario").split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase() || "usuario");
  const open = (positions.data ?? []).filter((p) => !p.redeemable && p.size > 0);
  const redeemables = (positions.data ?? []).filter((p) => p.redeemable && p.size > 0);
  const redeemableUsd = redeemables.reduce((s, p) => s + (p.curPrice >= 0.99 ? p.size : 0), 0);
  const totalPnl = (positions.data ?? []).reduce((s, p) => s + (p.cashPnl ?? 0) + (p.realizedPnl ?? 0), 0);
  const activating = step !== "idle" && step !== "complete";

  function ticketFor(p: Position): TicketData {
    const cost = costOf(p);
    const odds = cost > 0 ? p.size / cost : p.avgPrice > 0 ? 1 / p.avgPrice : 0;
    return {
      handle,
      avatar: handle,
      league: "Polymarket",
      matchup: p.title,
      selection: p.outcome,
      market: p.title.startsWith("Spread") ? "Hándicap" : /O\/U/.test(p.title) ? "Total" : "Ganador",
      odds,
      stake: cost,
      payout: p.size,
      placedAt: new Date().toISOString(),
      status: p.redeemable ? (p.curPrice >= 0.99 ? "won" : "lost") : "open",
      proof: p.conditionId,
    };
  }

  return (
    <>
      <TopBar title="Perfil" right={<button onClick={logout} aria-label="Salir" className="btn-ghost p-2"><LogOut className="h-4 w-4" /></button>} />
      <section className="px-4 pt-4">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <Avatar seed={handle} size={56} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-xl font-extrabold uppercase">@{handle}</div>
              <div className="truncate text-xs text-muted">{email}</div>
            </div>
            {me ? (
              <div className="flex shrink-0 flex-col gap-1.5">
                <Link href={`/u/${me.handle}`} className="btn-ghost px-3 py-1.5 text-center font-display text-[11px] font-bold uppercase">
                  Mi perfil
                </Link>
                <button onClick={() => setEditOpen(true)} className="btn-ghost px-3 py-1.5 font-display text-[11px] font-bold uppercase">
                  Editar
                </button>
              </div>
            ) : null}
          </div>
          {me ? (
            <div className="tnum mt-3 text-xs text-muted">
              Récord {me.record.w}-{me.record.l}
              {me.record.v ? `-${me.record.v}` : ""} · {me.followers} seguidores · ROI {me.roi >= 0 ? "+" : ""}
              {me.roi.toFixed(1)}%
            </div>
          ) : null}
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat k="Saldo" v={`$${formatUsd(balance)}`} />
            <Stat k="Abiertas" v={String(open.length)} />
            <Stat k="P&L" v={signed(totalPnl)} cls={totalPnl > 0 ? "text-win" : totalPnl < 0 ? "text-loss" : ""} />
          </div>
        </div>

        {/* Winnings ready to collect — shown first, one tap */}
        {isReady && redeemables.length > 0 ? (
          <div className="card-hot card mt-3 p-4">
            <div className="font-display text-sm font-extrabold uppercase">
              {redeemableUsd > 0 ? `Tienes $${formatUsd(redeemableUsd)} listos` : "Apuestas por cerrar"}
            </div>
            <p className="mt-1 text-xs text-muted">
              {redeemables.length} {redeemables.length === 1 ? "apuesta resuelta" : "apuestas resueltas"}. Cóbralas a tu saldo con una firma, sin gas.
            </p>
            <button onClick={() => run("redeem")} disabled={busy !== null} className="btn-accent mt-3 w-full py-2.5 text-xs">
              {busy === "redeem" ? "Cobrando…" : "Cobrar"}
            </button>
          </div>
        ) : null}

        {/* Account activation */}
        {!isReady ? (
          <div className="card-hot card mt-3 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-soft" />
              <div className="flex-1">
                <div className="font-display text-sm font-extrabold uppercase">Activa tu cuenta de trading</div>
                <p className="mt-1 text-xs text-muted">Creamos tu bóveda en Polygon y firmas los permisos. Una sola vez, sin gas, sin costo.</p>
                {!builderReady ? (
                  <p className="mt-2 text-xs text-accent-soft">Patoli aún no está conectado a Polymarket. En cuanto esté, aquí activas tu cuenta.</p>
                ) : null}
                {activating ? <p className="pulse-soft mt-2 text-xs text-accent-soft">{SESSION_STEP_LABEL[step]}</p> : null}
                {error && builderReady ? <p className="mt-2 text-xs text-loss">{error.message}</p> : null}
                <button
                  onClick={() => setupTrading().catch(() => undefined)}
                  disabled={activating || !builderReady}
                  className="btn-accent mt-3 w-full py-2.5 text-xs"
                >
                  {!builderReady ? "Muy pronto" : activating ? "Un momento…" : "Activar"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Funds waiting to be converted */}
        {isReady && pendingUsdc > 0 ? (
          <div className="card-hot card mt-3 p-4">
            <div className="flex items-start gap-3">
              <ArrowDownToLine className="mt-0.5 h-5 w-5 shrink-0 text-accent-soft" />
              <div className="flex-1">
                <div className="font-display text-sm font-extrabold uppercase">Llegaron ${formatUsd(pendingUsdc)} USDC</div>
                <p className="mt-1 text-xs text-muted">Polymarket opera con pUSD (dólar 1 a 1). Conviértelos para poder apostar. Sin gas, sin costo.</p>
                <button onClick={() => run("wrap")} disabled={busy !== null} className="btn-accent mt-3 w-full py-2.5 text-xs">
                  {busy === "wrap" ? "Convirtiendo…" : `Convertir a pUSD`}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Funds parked in the v1 Safe (early testers only) */}
        {isReady && legacyUsdc > 0 && legacySafeAddress ? (
          <div className="card mt-3 p-4">
            <div className="font-display text-sm font-extrabold uppercase">Saldo en tu bóveda anterior</div>
            <p className="mt-1 text-xs text-muted">
              Tienes ${formatUsd(legacyUsdc)} USDC en {shortAddress(legacySafeAddress)}. Muévelos a tu bóveda nueva en un toque.
            </p>
            <button onClick={() => run("migrate")} disabled={busy !== null} className="btn-ghost mt-3 w-full py-2.5 font-display text-xs font-bold uppercase">
              {busy === "migrate" ? "Moviendo…" : "Mover a la bóveda nueva"}
            </button>
          </div>
        ) : null}
        {opError ? <p className="mt-2 text-xs text-loss">{opError}</p> : null}

        {/* Deposit / withdraw */}
        <div className="card mt-3 p-4">
          <div className="flex items-center justify-between">
            <div className="font-display text-sm font-extrabold uppercase">Depositar</div>
            {isReady ? (
              <button onClick={() => setWithdrawOpen(true)} disabled={balance <= 0} className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 font-display text-[11px] font-bold uppercase">
                <ArrowUpFromLine className="h-3.5 w-3.5" /> Retirar
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">Manda USDC (red Polygon) a tu dirección. Desde Bitso, otra wallet o tu cuenta de Polymarket.</p>
          <div className="tnum mt-3 flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm">
            <button
              type="button"
              onClick={() => setShowFullAddress((v) => !v)}
              className={cn("min-w-0 select-all text-left", showFullAddress && "break-all text-xs")}
              title="Toca para ver la dirección completa"
            >
              {walletAddress ? (showFullAddress ? walletAddress : shortAddress(walletAddress, 6)) : "…"}
            </button>
            <button
              onClick={async () => {
                if (!walletAddress) return;
                const ok = await copyText(walletAddress);
                setCopied(ok ? "ok" : "fail");
                if (!ok) setShowFullAddress(true);
                setTimeout(() => setCopied("idle"), 1800);
              }}
              disabled={!walletAddress}
              className="flex shrink-0 items-center gap-1 text-xs text-accent-soft"
            >
              <Copy className="h-3.5 w-3.5" /> {copied === "ok" ? "Copiado" : copied === "fail" ? "Mantén presionado" : "Copiar"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted-2">USDC.e o pUSD en Polygon. Otra red u otra moneda se pierde. {!isReady ? "Activa tu cuenta antes de depositar." : ""}</p>
        </div>

        {/* Open bets */}
        <h2 className="mt-6 text-lg">Apuestas abiertas</h2>
        <ul className="mt-2 space-y-2">
          {positions.isLoading ? <li className="skeleton h-16" /> : null}
          {open.map((p) => (
            <li key={`${p.conditionId}-${p.outcome}`}>
              <button onClick={() => setTicket(ticketFor(p))} className="card flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left active:border-accent">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{p.title}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    {p.outcome} <TicketIcon className="h-3 w-3 text-accent-soft" />
                  </div>
                </div>
                <div className="tnum text-right">
                  <div className="text-sm font-semibold">${formatUsd(costOf(p))}</div>
                  <div className={cn("text-xs", (p.cashPnl ?? 0) >= 0 ? "text-win" : "text-loss")}>
                    {signed(p.cashPnl ?? 0)} · {p.size.toFixed(1)} × {(p.curPrice ?? 0).toFixed(2)}
                  </div>
                </div>
              </button>
            </li>
          ))}
          {!positions.isLoading && open.length === 0 ? <li className="card p-4 text-center text-sm text-muted">Aún no tienes apuestas abiertas. Ve a Deportes.</li> : null}
        </ul>

        <a
          href={POLYMARKET_PROFILE_URL(walletAddress ?? "")}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted"
        >
          Ver historial completo on-chain <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <p className="tnum mt-2 pb-2 text-center text-[11px] text-muted-2">Wallet {shortAddress(eoaAddress)}</p>
      </section>

      <WithdrawSheet open={withdrawOpen} onClose={() => setWithdrawOpen(false)} available={balance} onDone={() => refetch()} />
      {editOpen ? <EditProfileSheet open={editOpen} onClose={() => setEditOpen(false)} /> : null}
      <Sheet open={!!ticket} onClose={() => setTicket(null)} title="Tu boleto">
        {ticket ? <TicketShare data={ticket} onDone={() => setTicket(null)} /> : null}
      </Sheet>
    </>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="rounded-xl bg-surface/60 px-2 py-2.5">
      <div className={cn("tnum font-display text-lg font-extrabold", cls)}>{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
    </div>
  );
}
