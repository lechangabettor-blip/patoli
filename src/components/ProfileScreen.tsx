"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Copy, ExternalLink, LogOut, ShieldCheck } from "lucide-react";
import TopBar from "./TopBar";
import Avatar from "./Avatar";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsd } from "@/lib/polymarket/odds";
import { shortAddress, signed } from "@/lib/format";
import { POLYMARKET_PROFILE_URL } from "@/lib/polymarket/constants";
import { SESSION_STEP_LABEL } from "@/lib/polymarket/session";
import { cn } from "@/lib/cn";

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
  endDate?: string;
  slug?: string;
}

/** Cost basis in USDC; the data API can lag avgPrice right after a fill. */
const costOf = (p: Position) => (p.initialValue && p.initialValue > 0 ? p.initialValue : p.size * (p.avgPrice || 0));

export default function ProfileScreen() {
  const { status, email, eoaAddress, logout, isDemo } = useWallet();
  const { walletAddress, legacySafeAddress, isReady, step, setupTrading, error, wrapUsdc, migrateFromSafe } = useTrading();
  const { balance, pendingUsdc, pendingUsdcRaw, legacyUsdc, legacyUsdcRaw, refetch } = useUsdcBalance();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"wrap" | "migrate" | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

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

  async function run(kind: "wrap" | "migrate") {
    setOpError(null);
    setBusy(kind);
    try {
      if (kind === "wrap") await wrapUsdc(pendingUsdcRaw);
      else await migrateFromSafe(legacyUsdcRaw);
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
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-surface text-4xl">🦧</div>
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

  const handle = (email ?? "usuario").split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase() || "usuario";
  const open = (positions.data ?? []).filter((p) => !p.redeemable && p.size > 0);
  const totalPnl = (positions.data ?? []).reduce((s, p) => s + (p.cashPnl ?? 0) + (p.realizedPnl ?? 0), 0);
  const activating = step !== "idle" && step !== "complete";

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
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat k="Saldo" v={`$${formatUsd(balance)}`} />
            <Stat k="Abiertas" v={String(open.length)} />
            <Stat k="P&L" v={signed(totalPnl)} cls={totalPnl > 0 ? "text-win" : totalPnl < 0 ? "text-loss" : ""} />
          </div>
        </div>

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

        {/* Deposit */}
        <div className="card mt-3 p-4">
          <div className="font-display text-sm font-extrabold uppercase">Depositar</div>
          <p className="mt-1 text-xs text-muted">Manda USDC (red Polygon) a tu dirección. Desde Bitso, otra wallet o tu cuenta de Polymarket.</p>
          <div className="tnum mt-3 flex items-center justify-between rounded-xl bg-surface px-3 py-2 text-sm">
            <span>{walletAddress ? shortAddress(walletAddress, 6) : "…"}</span>
            <button
              onClick={() => {
                if (walletAddress) navigator.clipboard?.writeText(walletAddress).then(() => setCopied(true));
                setTimeout(() => setCopied(false), 1500);
              }}
              disabled={!walletAddress}
              className="flex items-center gap-1 text-xs text-accent-soft"
            >
              <Copy className="h-3.5 w-3.5" /> {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted-2">USDC.e o pUSD en Polygon. Otra red u otra moneda se pierde. {!isReady ? "Activa tu cuenta antes de depositar." : ""}</p>
        </div>

        {/* Open bets */}
        <h2 className="mt-6 text-lg">Apuestas abiertas</h2>
        <ul className="mt-2 space-y-2">
          {positions.isLoading ? <li className="skeleton h-16" /> : null}
          {open.map((p) => (
            <li key={`${p.conditionId}-${p.outcome}`} className="card px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{p.title}</div>
                  <div className="text-xs text-muted">{p.outcome}</div>
                </div>
                <div className="tnum text-right">
                  <div className="text-sm font-semibold">${formatUsd(costOf(p))}</div>
                  <div className={cn("text-xs", (p.cashPnl ?? 0) >= 0 ? "text-win" : "text-loss")}>
                    {signed(p.cashPnl ?? 0)} · {p.size.toFixed(1)} × {(p.curPrice ?? 0).toFixed(2)}
                  </div>
                </div>
              </div>
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
