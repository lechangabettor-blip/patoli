"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpenOrder } from "@polymarket/clob-client-v2";
import { useTrading } from "@/providers/TradingProvider";
import type { MarketInfo } from "@/app/api/markets/lookup/route";

export interface BookLevel {
  price: number; // 0–1
  size: number; // shares
  usd: number; // price × size, rounded
}

export interface BookTop {
  asks: BookLevel[]; // cheapest first
  bids: BookLevel[]; // best first
  tickSize: number;
  minOrderSize: number;
}

/** Top of the book for one outcome (2 asks, 2 bids), every 3 s while the Límite view is open. */
export function useBook(tokenId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["book", tokenId],
    enabled: enabled && !!tokenId,
    refetchInterval: enabled ? 3_000 : false,
    staleTime: 2_000,
    queryFn: async (): Promise<BookTop> => {
      const r = await fetch(`/api/book?tokenId=${encodeURIComponent(tokenId)}`);
      if (!r.ok) throw new Error("book");
      return r.json();
    },
  });
}

/** The user's resting limit orders on Polymarket (needs the trading session). */
export function useOpenOrders() {
  const { clobClient, isReady } = useTrading();
  return useQuery({
    queryKey: ["open-orders"],
    enabled: !!clobClient && isReady,
    refetchInterval: 15_000,
    queryFn: async (): Promise<OpenOrder[]> => {
      const r = (await clobClient!.getOpenOrders()) as unknown;
      if (Array.isArray(r)) return r as OpenOrder[];
      return ((r as { data?: OpenOrder[] })?.data ?? []) as OpenOrder[];
    },
  });
}

export function useCancelOrder() {
  const { clobClient } = useTrading();
  const qc = useQueryClient();
  return useCallback(
    async (orderID: string): Promise<boolean> => {
      if (!clobClient) return false;
      try {
        await clobClient.cancelOrder({ orderID });
        qc.invalidateQueries({ queryKey: ["open-orders"] });
        qc.invalidateQueries({ queryKey: ["balances"] });
        return true;
      } catch (e) {
        console.warn("[patoli] cancel failed", e);
        return false;
      }
    },
    [clobClient, qc],
  );
}

/** Labels for a set of condition ids (open orders only carry ids). */
export function useMarketInfo(conditionIds: string[]) {
  const key = [...new Set(conditionIds.map((c) => c.toLowerCase()))].sort().join(",");
  return useQuery({
    queryKey: ["market-info", key],
    enabled: key.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, MarketInfo>> => {
      const r = await fetch("/api/markets/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conditionIds: key.split(",") }) });
      return r.ok ? r.json() : {};
    },
  });
}
