"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AssetType, OrderType, Side } from "@polymarket/clob-client-v2";
import type { TickSize } from "@polymarket/clob-client-v2";
import { useTrading } from "@/providers/TradingProvider";
import { PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";
import { useSyncBets } from "@/hooks/useSocial";

export interface PlaceBetParams {
  tokenId: string;
  /** Stake in USDC */
  stake: number;
  negRisk: boolean;
  tickSize: number;
  /** The price the user saw (0–1). The order fills at this price or better, never worse — or it is rejected. */
  price: number;
}

export type PlaceBetResult =
  | { ok: true; orderId: string; txHashes: string[] }
  | { ok: false; reason: string; lineMoved?: boolean };

// Per-session memory so a 2nd bet skips the slow pre-checks (approvals on-chain, CLOB balance cache).
// Cleared when an order fails for a reason those checks would have caught.
let approvalsOk = false;
let collateralSynced = false;

/**
 * Places a BUY market order (fill-or-kill, capped at the price the user saw) for `stake` USDC on `tokenId`.
 * The user signs with their embedded wallet; funds move from their own Safe;
 * Patoli's builder code rides inside the signed order. We never touch money.
 */
export function usePlaceBet() {
  const { clobClient, ensureApprovals } = useTrading();
  const qc = useQueryClient();
  const syncBets = useSyncBets();
  const [isPlacing, setPlacing] = useState(false);

  const placeBet = useCallback(
    async ({ tokenId, stake, negRisk, tickSize, price }: PlaceBetParams): Promise<PlaceBetResult> => {
      if (!clobClient) return { ok: false, reason: "Primero activa tu cuenta de trading" };
      if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) {
        return { ok: false, reason: "Patoli aún no tiene su código de builder configurado. Pronto." };
      }
      setPlacing(true);
      try {
        // Permissions can grow over time (neg-risk adapter was added after the first wallets
        // were activated): top them up silently before the order if anything is missing.
        if (!approvalsOk) {
          try {
            const added = await ensureApprovals();
            if (added) await new Promise((r) => setTimeout(r, 1500)); // let the CLOB see the new allowance
            approvalsOk = true;
          } catch (e) {
            console.warn("[patoli] ensureApprovals failed", e);
          }
        }
        // The CLOB caches each wallet's collateral balance/allowance. A fresh
        // Safe (or a fresh deposit) must be re-synced or orders get rejected
        // with "not enough balance / allowance" even though the chain is fine.
        // The refresh is async on their side: poll briefly, never block on it.
        if (!collateralSynced) {
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
        }

        // Cap = the price on the button, snapped to the market's tick. Fill-or-kill at that price or
        // better; if the line moved against the user, the order is rejected and we re-quote instead
        // of filling at a price they never saw.
        const cap = Math.min(1 - tickSize, Math.max(tickSize, Math.round(price / tickSize) * tickSize));

        const res = await clobClient.createAndPostMarketOrder(
          { tokenID: tokenId, amount: stake, side: Side.BUY, orderType: OrderType.FOK, price: Number(cap.toFixed(4)) },
          { tickSize: String(tickSize) as TickSize, negRisk },
          OrderType.FOK,
        );

        if (!res?.success || !res.orderID) {
          console.error("[patoli] order rejected", res);
          return rejection(res);
        }
        collateralSynced = true;
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["balances"] });
        // Index the fill into our DB (Perfil/feed read from there). Polymarket's
        // trade feed lags a few seconds, so retry a couple of times in the background.
        void syncBets([1_500, 6_000, 15_000]);
        return { ok: true, orderId: res.orderID, txHashes: res.transactionsHashes ?? [] };
      } catch (e) {
        console.error("[patoli] order threw", e);
        return rejection(e);
      } finally {
        setPlacing(false);
      }
    },
    [clobClient, qc, syncBets, ensureApprovals],
  );

  return { placeBet, isPlacing };
}

/** Classify a failure; forget the session shortcuts when they could be the cause. */
function rejection(res: unknown): PlaceBetResult {
  const text = rawError(res);
  if (/not enough balance|insufficient|allowance/i.test(text)) collateralSynced = false;
  if (/allowance|approv/i.test(text)) approvalsOk = false;
  const lineMoved = /fok|fill or kill|fully filled|not filled|no liquidity|unmatched|no match|price/i.test(text) && !/min.*size|minimum/i.test(text);
  return { ok: false, reason: describeRejection(res), lineMoved };
}

function rawError(res: unknown): string {
  const r = (res ?? {}) as { errorMsg?: string; message?: string; error?: unknown };
  const nested = r.error as { error?: string; message?: string } | string | undefined;
  return String(r.errorMsg || r.message || (typeof nested === "string" ? nested : nested?.error || nested?.message) || (r.error ? JSON.stringify(r.error) : "") || "");
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
      ? "Se movió la línea o no hay liquidez a ese precio. Revisa el precio nuevo y toca de nuevo."
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
