"use client";

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { fetchPositions, type Position } from "@/lib/polymarket/public-api";

export type { Position };

/** The user's live Polymarket positions (Data API v2, straight from the browser). One shared query: Perfil and the auto-collector read the same data. */
export function usePositions(refetchInterval = 20_000) {
  const { status } = useWallet();
  const { walletAddress } = useTrading();
  return useQuery({
    queryKey: ["positions", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval,
    queryFn: () => fetchPositions(walletAddress!),
  });
}
