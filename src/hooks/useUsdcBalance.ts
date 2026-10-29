"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatUnits } from "viem";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { PUSD_ADDRESS, PUSD_DECIMALS, USDC_E_ADDRESS, USDC_E_DECIMALS, USDC_NATIVE_ADDRESS } from "@/lib/polymarket/constants";
import { publicClient } from "@/lib/polymarket/v2";

/**
 * The user's money, as the app presents it ("Saldo"):
 *  - balance:      pUSD in the deposit wallet (what can be bet right now)
 *  - pendingUsdc:  USDC.e in the deposit wallet (wrapped to pUSD automatically; Convertir is the fallback)
 *  - nativeUsdc:   native USDC sent by mistake (rescued via wrap or bridge)
 * One multicall per poll instead of three RPC round trips.
 */
export function useUsdcBalance() {
  const { status } = useWallet();
  const { walletAddress } = useTrading();
  const q = useQuery({
    queryKey: ["balances", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval: 15_000,
    queryFn: async () => {
      const owner = walletAddress!;
      const res = await publicClient.multicall({
        contracts: [PUSD_ADDRESS, USDC_E_ADDRESS, USDC_NATIVE_ADDRESS].map((address) => ({ address, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const })),
        allowFailure: true,
      });
      // An RPC outage marks every call as failed: throw so React Query keeps the last good numbers
      // instead of showing $0.00 and disabling Apostar for a poll.
      if (res.every((r) => r.status !== "success")) throw new Error("balance read failed");
      const at = (i: number) => (res[i]?.status === "success" ? (res[i].result as bigint) : 0n);
      return { pusd: at(0), usdc: at(1), native: at(2) };
    },
  });
  const toNum = (v: bigint | undefined, d: number) => (v === undefined ? 0 : parseFloat(formatUnits(v, d)));
  return {
    balance: toNum(q.data?.pusd, PUSD_DECIMALS),
    pendingUsdc: toNum(q.data?.usdc, USDC_E_DECIMALS),
    pendingUsdcRaw: q.data?.usdc ?? 0n,
    nativeUsdc: toNum(q.data?.native, USDC_E_DECIMALS),
    nativeUsdcRaw: q.data?.native ?? 0n,
    isLoading: q.isLoading && status === "connected",
    refetch: q.refetch,
  };
}
