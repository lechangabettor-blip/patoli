"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePositions } from "@/hooks/usePositions";
import { useNow } from "@/hooks/useNow";
import type { AutoRedeemNote } from "@/components/AutoSettle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Copy, ExternalLink, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
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
import FeedCard from "./FeedCard";
import LimitOrders from "./LimitOrders";
import HistoryTabs from "./HistoryTabs";
import StatsWindows from "./StatsWindows";
import { ticketFromItem, useMoney, useSyncBets, useUser } from "@/hooks/useSocial";
import { useArenaActions, useArenaMe } from "@/hooks/useArena";
import { isArenaConfigured } from "@/lib/arena/typed-data";
import { copyText } from "@/lib/clipboard";


export default function ProfileScreen() {
  const { status, email, eoaAddress, logout, isDemo } = useWallet();
  const { me } = useMe();
  const { walletAddress, isReady, step, setupTrading, error, wrapUsdc, rescueNativeUsdc, redeem } = useTrading();
  const { balance, pendingUsdc, pendingUsdcRaw, nativeUsdc, nativeUsdcRaw, refetch } = useUsdcBalance();
  const [rescueNote, setRescueNote] = useState<string | null>(null);
  const arenaMe = useArenaMe();
  const arena = useArenaActions();
  const [arenaBusy, setArenaBusy] = useState(false);
  const [arenaErr, setArenaErr] = useState<string | null>(null);

  async function withdrawArena() {
    const a = arenaMe.data;
    if (!a || !walletAddress || a.balance <= 0) return;
    setArenaErr(null);
    setArenaBusy(true);
    try {
      await arena.withdraw(a.free ?? a.balance, a.nonce, walletAddress as `0x${string}`);
      await refetch();
      await arenaMe.refetch();
    } catch (e) {
      setArenaErr(e instanceof Error ? e.message : "No se pudo retirar");
    } finally {
      setArenaBusy(false);
    }
  }
  const qc = useQueryClient();
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [showFullAddress, setShowFullAddress] = useState(false);
  const [busy, setBusy] = useState<"wrap" | "redeem" | "rescue" | null>(null);
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

  // Bets (open and settled) come from our DB — the same source as the public
  // profile and the feed. Polymarket positions below are only a background check
  // (Cobrar + "is the indexer behind?"), never what the user sees as their record.
  const mine = useUser(me?.handle ?? null);
  const money = useMoney();
  const myBets = mine.data?.bets ?? [];
  const open = myBets.filter((b) => b.status === "open");
  const history = myBets.filter((b) => b.status !== "open");
  const syncBets = useSyncBets();
  const [syncing, setSyncing] = useState(false);

  // on-chain truth from Polymarket's Data API: used for Cobrar and as a lag detector
  const positions = usePositions();
  const autoNote = useQuery<AutoRedeemNote | null>({ queryKey: ["autoRedeem"], queryFn: () => null, staleTime: Infinity });
  const nowMs = useNow()?.getTime() ?? 0;
  const justCollected = autoNote.data && nowMs - autoNote.data.at < 60_000 ? autoNote.data : null;

  // Indexer behind? (Polymarket shows more live positions than our DB has open bets.)
  const livePositions = (positions.data ?? []).filter((p) => !p.redeemable && p.size > 0).length;
  const behind = !!me && !mine.isLoading && !positions.isLoading && livePositions > open.length;
  const lastAutoSync = useRef(0);
  useEffect(() => {
    if (!behind || Date.now() - lastAutoSync.current < 20_000) return;
    lastAutoSync.current = Date.now();
    void syncBets([0, 8_000]);
  }, [behind, syncBets]);

  async function manualSync() {
    setSyncing(true);
    try {
      await syncBets([0]);
      await positions.refetch();
    } finally {
      setSyncing(false);
    }
  }

  async function run(kind: "wrap" | "redeem" | "rescue") {
    setOpError(null);
    setBusy(kind);
    try {
      if (kind === "wrap") await wrapUsdc(pendingUsdcRaw);
      else if (kind === "rescue") {
        const path = await rescueNativeUsdc(nativeUsdcRaw);
        setRescueNote(
          path === "wrap"
            ? "Listo. Tus USDC ya son pUSD."
            : "Enviado al puente de Polymarket. En unos minutos aparece en tu saldo como pUSD.",
        );
      } else {
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
  const redeemables = (positions.data ?? []).filter((p) => p.redeemable && p.size > 0);
  const redeemableUsd = redeemables.reduce((s, p) => s + (p.curPrice >= 0.99 ? p.size : 0), 0);
  // P&L = settled record from the indexer — exactly what everyone else sees on your profile
  const totalPnl = me?.pnl ?? 0;
  const avatar = me?.avatar || handle;
  const displayName = me?.displayName || handle;
  const activating = step !== "idle" && step !== "complete";

  return (
    <>
      <TopBar title="Perfil" right={<button onClick={logout} aria-label="Salir" className="btn-ghost p-2"><LogOut className="h-4 w-4" /></button>} />
      <section className="px-4 pt-4">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <Avatar seed={avatar} size={56} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-lg font-extrabold uppercase leading-tight">{displayName}</div>
              <div className="truncate text-sm text-muted">@{handle}</div>
              <div className="truncate text-[11px] text-muted-2">{email}</div>
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
            <>
              <div className="tnum mt-3 text-xs text-muted">
                {me.followers} seguidores · {me.following} siguiendo
                {me.tipsReceived ? <> · tips recibidos <b className="text-ink">${formatUsd(me.tipsReceived)}</b></> : null}
              </div>
              <StatsWindows profile={me} compact />
            </>
          ) : null}
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat k="Saldo" v={`$${formatUsd(balance)}`} />
            <Stat k="Abiertas" v={String(open.length)} />
            <Stat k="P&L" v={signed(totalPnl)} cls={totalPnl > 0 ? "text-win" : totalPnl < 0 ? "text-loss" : ""} />
          </div>
        </div>

        {justCollected && redeemables.length === 0 ? (
          <div className="card mt-3 p-3 text-xs text-win">
            {justCollected.usd > 0 ? `Cobrado: ${formatUsd(justCollected.usd)} ya están en tu saldo.` : "Tus apuestas resueltas ya se cerraron."}
          </div>
        ) : null}
        {/* Winnings ready to collect — shown first, one tap */}
        {isReady && redeemables.length > 0 ? (
          <div className="card-hot card mt-3 p-4">
            <div className="font-display text-sm font-extrabold uppercase">
              {redeemableUsd > 0 ? `Tienes $${formatUsd(redeemableUsd)} listos` : "Apuestas por cerrar"}
            </div>
            <p className="mt-1 text-xs text-muted">
              {redeemables.length} {redeemables.length === 1 ? "apuesta resuelta" : "apuestas resueltas"}. Se cobran solas en unos segundos; si no, toca Cobrar.
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

        {/* Native USDC sent by mistake — rescue it instead of letting it sit there */}
        {isReady && nativeUsdc > 0 ? (
          <div className="card-hot card mt-3 p-4">
            <div className="flex items-start gap-3">
              <ArrowDownToLine className="mt-0.5 h-5 w-5 shrink-0 text-accent-soft" />
              <div className="flex-1">
                <div className="font-display text-sm font-extrabold uppercase">Llegaron ${formatUsd(nativeUsdc)} USDC nativos</div>
                <p className="mt-1 text-xs text-muted">
                  Son USDC de Circle, no USDC.e. No se pierden: los convertimos a pUSD por el puente de Polymarket. Sin gas, sin costo.
                </p>
                <button onClick={() => run("rescue")} disabled={busy !== null} className="btn-accent mt-3 w-full py-2.5 text-xs">
                  {busy === "rescue" ? "Convirtiendo…" : "Convertir a pUSD"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {rescueNote ? <p className="mt-2 text-xs text-win">{rescueNote}</p> : null}

        {/* Arena balance (PvP escrow) */}
        {isArenaConfigured() && isReady && arenaMe.data ? (
          <div className="card mt-3 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-sm font-extrabold uppercase">Arena</div>
                <p className="mt-0.5 text-xs text-muted">Tu fondo para piedra, papel o tijera.</p>
              </div>
              <div className="tnum font-display text-lg font-extrabold">${formatUsd(arenaMe.data.balance)}</div>
            </div>
            {arenaMe.data.pending ? (
              <p className="mt-2 text-xs text-accent-soft">Retiro en curso: ${formatUsd(arenaMe.data.pending.amount)}.</p>
            ) : arenaMe.data.balance > 0 ? (
              <button
                onClick={withdrawArena}
                disabled={arenaBusy || !!arenaMe.data.matchId}
                className="btn-ghost mt-3 w-full py-2.5 font-display text-xs font-bold uppercase"
              >
                {arenaBusy ? "Retirando…" : arenaMe.data.matchId ? "Termina tu partida primero" : "Regresar todo a mi saldo"}
              </button>
            ) : (
              <Link href="/batalla" className="btn-ghost mt-3 block w-full py-2.5 text-center font-display text-xs font-bold uppercase">
                Fondear en Batalla
              </Link>
            )}
            {arenaErr ? <p className="mt-2 text-xs text-loss">{arenaErr}</p> : null}
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
          <p className="mt-2 text-[11px] text-muted-2">
            USDC, USDC.e o pUSD, siempre en red Polygon. Otra red se pierde. {!isReady ? "Activa tu cuenta antes de depositar." : ""}
          </p>
        </div>

        <LimitOrders />

        {/* Open bets — from our DB, same cards as the feed */}
        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-lg">Apuestas abiertas</h2>
          {me ? (
            <button onClick={manualSync} disabled={syncing} aria-label="Actualizar" className="btn-ghost flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-muted">
              <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} /> {behind ? "Sincronizando…" : "Actualizar"}
            </button>
          ) : null}
        </div>
        <div className="mt-2 space-y-3">
          {mine.isLoading ? <div className="skeleton h-24" /> : null}
          {open.map((b, i) => (
            <FeedCard key={b.id} item={b} index={i} onTicket={(it) => setTicket(ticketFromItem(it))} />
          ))}
          {!mine.isLoading && open.length === 0 ? (
            <p className="card p-4 text-center text-sm text-muted">
              {behind ? "Tu última apuesta se está registrando…" : "Aún no tienes apuestas abiertas. Ve a Deportes."}
            </p>
          ) : null}
        </div>

        {/* Settled bets — the public, verifiable record */}
        {me ? (
          <>
            <HistoryTabs items={history} loading={mine.isLoading} onTicket={(it) => setTicket(ticketFromItem(it))} money={{ rows: money.data ?? [], loading: money.isLoading }} />
          </>
        ) : null}

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
