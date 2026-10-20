"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { PUSD_ADDRESS, PUSD_DECIMALS, USDC_E_ADDRESS, USDC_E_DECIMALS, USDC_NATIVE_ADDRESS } from "@/lib/polymarket/constants";
import { erc20Balance } from "@/lib/polymarket/v2";

/**
 * The user's money, as the app presents it ("Saldo"):
 *  - balance:      pUSD in the deposit wallet (what can be bet right now)
 *  - pendingUsdc:  USDC.e in the deposit wallet (needs a gasless wrap → pUSD)
 *  - nativeUsdc:   native USDC sent by mistake (rescued via wrap or bridge)
 */
export function useUsdcBalance() {
  const { status } = useWallet();
  const { walletAddress } = useTrading();
  const q = useQuery({
    queryKey: ["balances", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval: 15_000,
    queryFn: async () => {
      const [pusd, usdc, native] = await Promise.all([
        erc20Balance(PUSD_ADDRESS, walletAddress!),
        erc20Balance(USDC_E_ADDRESS, walletAddress!),
        erc20Balance(USDC_NATIVE_ADDRESS, walletAddress!).catch(() => 0n),
      ]);
      return { pusd, usdc, native };
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
