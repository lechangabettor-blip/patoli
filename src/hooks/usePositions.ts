"use client";

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";

/** A position as Polymarket's Data API reports it for the deposit wallet (on-chain truth). */
interface Position {
  conditionId: string;
  asset: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl: number;
  realizedPnl: number;
  redeemable: boolean;
  negativeRisk?: boolean;
  endDate?: string;
  slug?: string;
}

/** The user's live Polymarket positions. One shared query: Perfil and the auto-collector read the same data. */
export function usePositions(refetchInterval = 20_000) {
  const { status } = useWallet();
  const { walletAddress } = useTrading();
  return useQuery({
    queryKey: ["positions", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval,
    queryFn: async (): Promise<Position[]> => {
      const r = await fetch(`/api/positions?user=${walletAddress}`);
      return r.ok ? r.json() : [];
    },
  });
}
