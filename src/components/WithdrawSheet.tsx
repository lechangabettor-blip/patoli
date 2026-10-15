"use client";

import { useState } from "react";
import { isAddress, parseUnits } from "viem";
import { CheckCircle2 } from "lucide-react";
import Sheet from "./Sheet";
import { useTrading } from "@/providers/TradingProvider";
import { formatUsd } from "@/lib/polymarket/odds";
import { POLYGONSCAN_TX_URL, PUSD_DECIMALS } from "@/lib/polymarket/constants";

/**
 * Retirar: pUSD in the vault → USDC.e delivered to any Polygon address, in one
 * gasless signed batch (approve offramp + unwrap to recipient).
 */
export default function WithdrawSheet({ open, onClose, available, onDone }: { open: boolean; onClose: () => void; available: number; onDone?: () => void }) {
  const { withdraw } = useTrading();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null | undefined>(undefined);

  const amt = Number(amount);
  const valid = isAddress(to) && amt > 0 && amt <= available + 1e-9;

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const hash = await withdraw(to as `0x${string}`, parseUnits(amt.toFixed(6), PUSD_DECIMALS));
      setTx(hash ?? null);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo retirar");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setTx(undefined);
    setErr(null);
    setAmount("");
    onClose();
  }

  return (
    <Sheet open={open} onClose={close} title="Retirar">
      {tx !== undefined ? (
        <div className="py-4 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-win" />
          <h3 className="mt-3 text-2xl">Enviado</h3>
          <p className="mt-1 text-sm text-muted">
            ${formatUsd(amt)} USDC.e van en camino a {to.slice(0, 6)}…{to.slice(-4)} (red Polygon).
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
          <p className="text-sm text-muted">
            Sale como <b className="text-ink">USDC.e en Polygon</b>. Sirve para tu cuenta de Polymarket, Bitso (red Polygon) o cualquier wallet. No mandes a una red distinta.
          </p>
          <label className="mt-4 block text-xs text-muted">Dirección destino (0x…)</label>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value.trim())}
            placeholder="0x…"
            spellCheck={false}
            autoCapitalize="none"
            className="tnum mt-1 w-full rounded-xl border border-hairline bg-surface px-3 py-3 text-sm outline-none focus:border-accent"
          />
          {to && !isAddress(to) ? <p className="mt-1 text-xs text-loss">Esa dirección no es válida.</p> : null}

          <div className="mt-3 flex items-center justify-between text-xs text-muted">
            <span>Monto (USDC)</span>
            <button onClick={() => setAmount(available.toFixed(2))} className="tnum text-accent-soft">
              Todo · ${formatUsd(available)}
            </button>
          </div>
          <div className="mt-1 flex items-center rounded-xl border border-hairline bg-surface px-3">
            <span className="text-muted">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tnum w-full bg-transparent py-3 pl-1 text-xl font-semibold outline-none"
            />
          </div>
          {amt > available ? <p className="mt-1 text-xs text-loss">No tienes tanto saldo disponible.</p> : null}
          {err ? <p className="mt-3 text-center text-xs text-loss">{err}</p> : null}
          <button onClick={submit} disabled={!valid || busy} className="btn-accent mt-4 w-full py-3.5 text-sm">
            {busy ? "Firmando y enviando…" : `Retirar $${amt > 0 ? formatUsd(amt) : "0.00"}`}
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-2">Sin gas. Una firma. Tarda unos segundos en Polygon.</p>
        </div>
      )}
    </Sheet>
  );
}
