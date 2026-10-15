"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AssetType, OrderType, Side } from "@polymarket/clob-client-v2";
import type { TickSize } from "@polymarket/clob-client-v2";
import { useTrading } from "@/providers/TradingProvider";
import { PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";

export interface PlaceBetParams {
  tokenId: string;
  /** Stake in USDC */
  stake: number;
  negRisk: boolean;
  tickSize: number;
}

export type PlaceBetResult =
  | { ok: true; orderId: string; txHashes: string[] }
  | { ok: false; reason: string };

/**
 * Places a BUY market order (fill-or-kill) for `stake` USDC on `tokenId`.
 * The user signs with their embedded wallet; funds move from their own Safe;
 * Patoli's builder code rides inside the signed order. We never touch money.
 */
export function usePlaceBet() {
  const { clobClient } = useTrading();
  const qc = useQueryClient();
  const [isPlacing, setPlacing] = useState(false);

  const placeBet = useCallback(
    async ({ tokenId, stake, negRisk, tickSize }: PlaceBetParams): Promise<PlaceBetResult> => {
      if (!clobClient) return { ok: false, reason: "Primero activa tu cuenta de trading" };
      if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) {
        return { ok: false, reason: "Patoli aún no tiene su código de builder configurado. Pronto." };
      }
      setPlacing(true);
      try {
        // The CLOB caches each wallet's collateral balance/allowance. A fresh
        // Safe (or a fresh deposit) must be re-synced or orders get rejected
        // with "not enough balance / allowance" even though the chain is fine.
        // The refresh is async on their side: poll briefly, never block on it.
        try {
          await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          for (let i = 0; i < 4; i++) {
            const ba = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const seen = Number(ba?.balance ?? 0) / 1e6;
            console.info("[patoli] CLOB sees collateral", ba);
            if (seen >= stake) break;
            await new Promise((r) => setTimeout(r, 800));
          }
        } catch (e) {
          console.warn("[patoli] balance/allowance sync failed", e);
        }

        const res = await clobClient.createAndPostMarketOrder(
          { tokenID: tokenId, amount: stake, side: Side.BUY, orderType: OrderType.FOK },
          { tickSize: String(tickSize) as TickSize, negRisk },
          OrderType.FOK,
        );

        if (!res?.success || !res.orderID) {
          console.error("[patoli] order rejected", res);
          return { ok: false, reason: describeRejection(res) };
        }
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["usdc"] });
        return { ok: true, orderId: res.orderID, txHashes: res.transactionsHashes ?? [] };
      } catch (e) {
        console.error("[patoli] order threw", e);
        return { ok: false, reason: describeRejection(e) };
      } finally {
        setPlacing(false);
      }
    },
    [clobClient, qc],
  );

  return { placeBet, isPlacing };
}

/** V2 returns `{ success, errorMsg, orderID }`; thrown ApiErrors carry a message. */
function describeRejection(res: unknown): string {
  const r = (res ?? {}) as { errorMsg?: string; message?: string; error?: unknown; status?: number | string };
  const nested = r.error as { error?: string; message?: string } | string | undefined;
  const raw =
    r.errorMsg ||
    r.message ||
    (typeof nested === "string" ? nested : nested?.error || nested?.message) ||
    (r.error ? JSON.stringify(r.error) : "");
  const text = String(raw || "");
  const friendly = /not enough balance|insufficient/i.test(text)
    ? "Saldo insuficiente en tu bóveda para esta apuesta."
    : /fok|fill or kill|couldn't be fully filled|not filled|no liquidity|unmatched/i.test(text)
      ? "No había suficiente liquidez para llenar la orden completa. Prueba un monto menor u otro mercado."
      : /min.*size|minimum/i.test(text)
        ? "El monto está por debajo del mínimo de este mercado."
        : /version/i.test(text)
          ? "Polymarket cambió el formato de órdenes. Actualiza la app."
          : /fee/i.test(text)
            ? "Polymarket rechazó la comisión de la orden. Reintenta en unos segundos."
            : /unauthorized|401|invalid signature|api key|credential/i.test(text)
              ? "Tu sesión de trading expiró. Sal y vuelve a entrar."
              : /denied|rejected|closed-by-user/i.test(text)
                ? "Cancelaste la firma."
                : "Polymarket rechazó la orden.";
  return text ? `${friendly} (${text.slice(0, 160)})` : friendly;
}
