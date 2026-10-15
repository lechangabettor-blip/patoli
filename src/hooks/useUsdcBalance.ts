"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits } from "viem";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { USDC_E_ADDRESS, USDC_E_DECIMALS } from "@/lib/polymarket/constants";

/** USDC.e balance of the user's Safe (the trading wallet). */
export function useUsdcBalance() {
  const { publicClient, status } = useWallet();
  const { safeAddress } = useTrading();
  const q = useQuery({
    queryKey: ["usdc", safeAddress],
    enabled: status === "connected" && !!safeAddress && !!publicClient,
    refetchInterval: 15_000,
    queryFn: async () => {
      const raw = await publicClient!.readContract({
        address: USDC_E_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [safeAddress!],
      });
      return parseFloat(formatUnits(raw, USDC_E_DECIMALS));
    },
  });
  return { balance: q.data ?? 0, isLoading: q.isLoading && status === "connected", refetch: q.refetch };
}
