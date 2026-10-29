"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchBuilderFee } from "@/lib/polymarket/public-api";

/** Live Patoli builder fee (bps) as Polymarket will charge it, read from the CLOB directly. 0 until the fee is enabled on their side. */
export function useBuilderFee() {
  const q = useQuery({ queryKey: ["builder-fee"], staleTime: 5 * 60_000, queryFn: fetchBuilderFee });
  return { takerBps: q.data?.takerBps ?? 0, makerBps: q.data?.makerBps ?? 0, targetBps: q.data?.targetBps ?? 0, isLoading: q.isLoading };
}
