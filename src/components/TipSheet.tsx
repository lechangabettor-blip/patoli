"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseUnits } from "viem";
import { CheckCircle2 } from "lucide-react";
import Sheet from "./Sheet";
import Avatar from "./Avatar";
import { useTrading } from "@/providers/TradingProvider";
import { useWallet } from "@/providers/WalletContext";
import { useMe } from "@/providers/MeProvider";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsd } from "@/lib/polymarket/odds";
import { POLYGONSCAN_TX_URL, PUSD_DECIMALS, TIP_MAX_USD } from "@/lib/polymarket/constants";
import type { PublicProfile } from "@/types/social";

/**
 * Tip: send pUSD from your deposit wallet straight to someone's (gasless, irreversible).
 * Amount typed by hand, $1–$100, no presets (his call). Private — nothing goes to the feed; the
 * server records it from the on-chain receipt so the recipient's own total in Perfil is real.
 */
export default function TipSheet({ to, open, onClose }: { to: Pick<PublicProfile, "handle" | "avatar" | "wallet">; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { status } = useWallet();
  const { getToken } = useMe();
  const { isReady, setupTrading, tip } = useTrading();
  const { balance, refetch } = useUsdcBalance();
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null | undefined>(undefined);

  const amt = Number(amount);
  const tooMuch = amt > TIP_MAX_USD;
  const noFunds = amt > balance + 1e-9;
  const valid = Number.isFinite(amt) && amt >= 1 && !tooMuch && !noFunds;
  const gated = status !== "connected" || !isReady;

  async function send() {
    setErr(null);
    if (status !== "connected") {
      router.push(`/entrar?next=/u/${to.handle}`);
      return;
    }
    setBusy(true);
    try {
      if (!isReady) {
        await setupTrading();
        return;
      }
      const hash = await tip(to.wallet as `0x${string}`, parseUnits(amt.toFixed(6), PUSD_DECIMALS));
      setTx(hash ?? null);
      void refetch();
      if (hash) void record(hash);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo enviar");
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  /** Tell the server; it verifies the receipt itself. Retry while the tx propagates. */
  async function record(hash: string) {
    for (const delay of [1_500, 4_000, 8_000, 15_000]) {
      await new Promise((r) => setTimeout(r, delay));
      const t = await getToken();
      if (!t) return;
      const r = await fetch("/api/tip", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ txHash: hash, to: to.handle }),
      });
      if (r.status !== 202) return;
    }
  }

  function close() {
    setTx(undefined);
    setErr(null);
    setAmount("");
    setConfirm(false);
    onClose();
  }

  const cta = status !== "connected" ? "Entrar para dar tip" : !isReady ? "Activar cuenta (1 vez)" : confirm ? `Confirmar $${formatUsd(amt)}` : "Dar tip";

  return (
    <Sheet open={open} onClose={close} title="Tip">
      {tx !== undefined ? (
        <div className="py-4 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-win" />
          <h3 className="mt-3 text-2xl">Enviado</h3>
          <p className="mt-1 text-sm text-muted">
            ${formatUsd(amt)} ya están en la cuenta de <b className="text-ink">@{to.handle}</b>.
          </p>
          {tx ? (
            <a href={POLYGONSCAN_TX_URL(tx)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent-soft underline">
              Ver transacción
            </a>
          ) : null}
          <button onClick={close} className="btn-accent mt-5 w-full py-3 text-sm">
            Listo
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-3">
            <Avatar seed={to.avatar} size={44} />
            <div>
              <div className="font-semibold">@{to.handle}</div>
              <div className="text-xs text-muted">Le llega directo a su saldo, sin comisión.</div>
            </div>
          </div>
          <label className="mt-4 block text-xs text-muted">Monto (pUSD)</label>
          <div className="mt-1 flex items-center rounded-xl border border-hairline bg-surface px-3 focus-within:border-accent">
            <span className="font-display text-xl font-extrabold text-muted">$</span>
            <input
              value={amount}
              onChange={(e) => {
                setConfirm(false);
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
              }}
              inputMode="decimal"
              placeholder="0"
              className="tnum w-full bg-transparent px-2 py-3 font-display text-2xl font-extrabold outline-none"
            />
          </div>
          <div className="tnum mt-1.5 flex justify-between text-xs text-muted">
            <span>Mínimo $1 · máximo ${TIP_MAX_USD}</span>
            <span>Saldo ${formatUsd(balance)}</span>
          </div>
          {tooMuch ? <p className="mt-1 text-xs text-loss">El tip máximo es ${TIP_MAX_USD}.</p> : null}
          {noFunds && !tooMuch && amt > 0 ? <p className="mt-1 text-xs text-loss">No te alcanza el saldo.</p> : null}
          {confirm ? (
            <p className="mt-3 rounded-xl border border-hairline bg-surface px-3 py-2 text-xs text-muted">
              Vas a enviar <b className="text-ink">${formatUsd(amt)}</b> a @{to.handle}. Esto no se puede deshacer.
            </p>
          ) : null}
          {err ? <p className="mt-2 text-xs text-loss">{err}</p> : null}
          <button
            onClick={() => (gated || confirm ? void send() : setConfirm(true))}
            disabled={busy || (!gated && !valid)}
            className="btn-accent mt-4 w-full py-3.5 text-sm disabled:opacity-50"
          >
            {busy ? "Enviando…" : cta}
          </button>
        </div>
      )}
    </Sheet>
  );
}
