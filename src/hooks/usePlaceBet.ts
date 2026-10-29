"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClobClient, TickSize } from "@polymarket/clob-client-v2";
import { useTrading } from "@/providers/TradingProvider";
import { useWallet } from "@/providers/WalletContext";
import { PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";
import { clobCache } from "@/lib/polymarket/clob-cache";
import { useSyncBets } from "@/hooks/useSocial";

interface PlaceBetParams {
  tokenId: string;
  /** Stake in USDC */
  stake: number;
  negRisk: boolean;
  tickSize: number;
  /** The price the user saw (0–1). The order fills at this price or better, never worse — or it is rejected. */
  price: number;
}

type PlaceBetResult =
  | { ok: true; orderId: string; txHashes: string[] }
  | { ok: false; reason: string; lineMoved?: boolean };

interface PlaceLimitParams {
  tokenId: string;
  /** Limit price (0–1), already on the market's tick */
  price: number;
  /** Shares to buy (stake / price), ≥ the market's minimum */
  shares: number;
  negRisk: boolean;
  tickSize: number;
  /** Unix seconds; Polymarket cancels whatever is unfilled then (we use kickoff) */
  expiresAt: number;
}

type PlaceLimitResult =
  | { ok: true; orderId: string; matched: boolean; txHashes: string[] }
  | { ok: false; reason: string };

// Per-session memory (lib/polymarket/clob-cache.ts) so a 2nd bet skips the slow pre-checks
// (approvals on-chain, CLOB balance cache). Cleared when an order fails for a reason those
// checks would have caught, and by the provider whenever a wrap or redeem changes the balance.
const NOT_READY = "Primero activa tu cuenta de trading";

/**
 * Places a BUY market order (fill-or-kill, capped at the price the user saw) for `stake` USDC on `tokenId`.
 * The user signs with their embedded wallet; funds move from their own deposit wallet;
 * Patoli's builder code rides inside the signed order. We never touch money.
 * The client is read at call time (`getClobClient`), so a first bet can activate the account and
 * place the order in the same tap.
 */
export function usePlaceBet() {
  const { getClobClient, ensureApprovals } = useTrading();
  const { sdk } = useWallet();
  const qc = useQueryClient();
  const syncBets = useSyncBets();
  const [isPlacing, setPlacing] = useState(false);

  /**
   * Permissions can grow over time (neg-risk adapter was added after the first wallets were
   * activated): top them up silently before an order if anything is missing. The CLOB also
   * caches each wallet's collateral balance/allowance: a fresh wallet (or a fresh deposit) must be
   * re-synced or orders get rejected with "not enough balance" even though the chain is fine.
   * The refresh is async on their side: poll briefly, never block on it.
   */
  const prepare = useCallback(
    async (client: ClobClient, stake: number) => {
      if (!sdk) return;
      const { AssetType } = sdk.clob;
      if (!clobCache.approvalsOk) {
        try {
          const added = await ensureApprovals();
          if (added) await new Promise((r) => setTimeout(r, 1500)); // let the CLOB see the new allowance
          clobCache.approvalsOk = true;
        } catch (e) {
          console.warn("[patoli] ensureApprovals failed", e);
        }
      }
      if (!clobCache.collateralSynced) {
        try {
          await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          for (let i = 0; i < 4; i++) {
            const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const seen = Number(ba?.balance ?? 0) / 1e6;
            if (seen >= stake) break;
            await new Promise((r) => setTimeout(r, 800));
          }
        } catch (e) {
          console.warn("[patoli] balance/allowance sync failed", e);
        }
      }
    },
    [sdk, ensureApprovals],
  );

  /**
   * Límite: a BUY order that rests on Polymarket's book at exactly `price` until filled or
   * `expiresAt` (good-till-date). If it crosses the book it fills right away like a market order.
   */
  const placeLimit = useCallback(
    async ({ tokenId, price, shares, negRisk, tickSize, expiresAt }: PlaceLimitParams): Promise<PlaceLimitResult> => {
      const client = getClobClient();
      if (!client || !sdk) return { ok: false, reason: NOT_READY };
      if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) return { ok: false, reason: "Patoli aún no tiene su código de builder configurado. Pronto." };
      // Polymarket: a GTD expiration must be ≥ 3 minutes ahead and the order dies one minute before it
      // (docs, 2026-10-29). Fail here with a clear message instead of a bare "invalid expiration".
      if (expiresAt - Math.floor(Date.now() / 1000) < 185) return { ok: false, reason: "Faltan menos de 3 minutos para el partido: Polymarket ya no acepta órdenes límite. Usa Mercado." };
      const { Side, OrderType } = sdk.clob;
      setPlacing(true);
      try {
        await prepare(client, shares * price);
        const px = Math.min(1 - tickSize, Math.max(tickSize, Math.round(price / tickSize) * tickSize));
        const res = await client.createAndPostOrder(
          { tokenID: tokenId, price: Number(px.toFixed(4)), size: Math.floor(shares * 100) / 100, side: Side.BUY, expiration: expiresAt },
          { tickSize: String(tickSize) as TickSize, negRisk },
          OrderType.GTD,
        );
        if (!res?.success || !res.orderID) {
          console.error("[patoli] limit order rejected", res);
          const r = rejection(res);
          return { ok: false, reason: r.ok ? "" : r.reason };
        }
        clobCache.collateralSynced = true;
        const matched = /matched/i.test(res.status ?? "") || (res.transactionsHashes?.length ?? 0) > 0;
        qc.invalidateQueries({ queryKey: ["open-orders"] });
        qc.invalidateQueries({ queryKey: ["balances"] });
        if (matched) {
          qc.invalidateQueries({ queryKey: ["positions"] });
          void syncBets([1_500, 6_000, 15_000]);
        }
        return { ok: true, orderId: res.orderID, matched, txHashes: res.transactionsHashes ?? [] };
      } catch (e) {
        console.error("[patoli] limit order threw", e);
        const r = rejection(e);
        return { ok: false, reason: r.ok ? "" : r.reason };
      } finally {
        setPlacing(false);
      }
    },
    [getClobClient, sdk, qc, syncBets, prepare],
  );

  const placeBet = useCallback(
    async ({ tokenId, stake, negRisk, tickSize, price }: PlaceBetParams): Promise<PlaceBetResult> => {
      const client = getClobClient();
      if (!client || !sdk) return { ok: false, reason: NOT_READY };
      if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) {
        return { ok: false, reason: "Patoli aún no tiene su código de builder configurado. Pronto." };
      }
      const { Side, OrderType } = sdk.clob;
      setPlacing(true);
      try {
        await prepare(client, stake);

        // Cap = the price on the button, snapped to the market's tick. Fill-or-kill at that price or
        // better; if the line moved against the user, the order is rejected and we re-quote instead
        // of filling at a price they never saw.
        const cap = Math.min(1 - tickSize, Math.max(tickSize, Math.round(price / tickSize) * tickSize));

        const res = await client.createAndPostMarketOrder(
          { tokenID: tokenId, amount: stake, side: Side.BUY, orderType: OrderType.FOK, price: Number(cap.toFixed(4)) },
          { tickSize: String(tickSize) as TickSize, negRisk },
          OrderType.FOK,
        );

        if (!res?.success || !res.orderID) {
          console.error("[patoli] order rejected", res);
          return rejection(res);
        }
        clobCache.collateralSynced = true;
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
    [getClobClient, sdk, qc, syncBets, prepare],
  );

  return { placeBet, placeLimit, isPlacing };
}

/** Classify a failure; forget the session shortcuts when they could be the cause. */
function rejection(res: unknown): PlaceBetResult {
  const text = rawError(res);
  if (/not enough balance|insufficient|allowance/i.test(text)) clobCache.collateralSynced = false;
  if (/allowance|approv/i.test(text)) clobCache.approvalsOk = false;
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
  const text = rawError(res);
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
