"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { OrderType, Side } from "@polymarket/clob-client";
import { useTrading } from "@/providers/TradingProvider";

export interface PlaceBetParams {
  tokenId: string;
  /** Stake in USDC */
  stake: number;
  negRisk: boolean;
  tickSize: number;
}

export type PlaceBetResult = { ok: true; orderId: string } | { ok: false; reason: string };

/**
 * Places a BUY market order (fill-or-kill) for `stake` USDC on `tokenId`,
 * attributed to Patoli's builder code. The user signs with their embedded
 * wallet; funds move from their own Safe. We never touch the money.
 */
export function usePlaceBet() {
  const { clobClient } = useTrading();
  const qc = useQueryClient();
  const [isPlacing, setPlacing] = useState(false);

  const placeBet = useCallback(
    async ({ tokenId, stake, negRisk, tickSize }: PlaceBetParams): Promise<PlaceBetResult> => {
      if (!clobClient) return { ok: false, reason: "Primero activa tu cuenta de trading" };
      setPlacing(true);
      try {
        const res = await clobClient.createAndPostMarketOrder(
          { tokenID: tokenId, amount: stake, side: Side.BUY },
          { negRisk, tickSize: String(tickSize) as "0.1" | "0.01" | "0.001" | "0.0001" },
          OrderType.FOK,
        );
        const orderId = (res as { orderID?: string })?.orderID;
        if (!orderId) {
          const msg = (res as { errorMsg?: string })?.errorMsg ?? "La orden no se llenó. Intenta con otro monto.";
          return { ok: false, reason: msg };
        }
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["usdc"] });
        return { ok: true, orderId };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : "No se pudo colocar la apuesta" };
      } finally {
        setPlacing(false);
      }
    },
    [clobClient, qc],
  );

  return { placeBet, isPlacing };
}
