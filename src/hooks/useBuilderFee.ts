"use client";

import { useQuery } from "@tanstack/react-query";

/** Live Patoli builder fee (bps) as Polymarket will charge it. 0 until the fee is enabled on their side. */
export function useBuilderFee() {
  const q = useQuery({
    queryKey: ["builder-fee"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ takerBps: number; makerBps: number; targetBps: number }> => {
      const r = await fetch("/api/polymarket/fees");
      return r.ok ? r.json() : { takerBps: 0, makerBps: 0, targetBps: 0 };
    },
  });
  return { takerBps: q.data?.takerBps ?? 0, targetBps: q.data?.targetBps ?? 0, isLoading: q.isLoading };
}
