"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAbi } from "viem";
import { useWallet } from "@/providers/WalletContext";
import { useTrading } from "@/providers/TradingProvider";
import { fetchPositions, type Position } from "@/lib/polymarket/public-api";
import { publicClient } from "@/lib/polymarket/v2";
import { V2_POSITION_MANAGER_ADDRESS } from "@/lib/polymarket/constants";

export type { Position };

const payoutAbi = parseAbi(["function getPayout(uint256 positionId, uint256 amount) view returns (uint256)"]);

/**
 * Protocol V2 rows: the Data API's `current_price` is a book mark, not a resolution value, and V2
 * books are thin — a resolved winner could read 0 and never be collected. `PositionManager.getPayout`
 * is exactly what the Router would mint: it reverts while the condition is unresolved (→ not
 * collectable yet), returns 0 for a loser, the full amount for a winner and a fraction on a split.
 * One multicall per poll, only when such rows exist; on an RPC hiccup the Data API view stands.
 */
async function valueV2OnChain(positions: Position[]): Promise<Position[]> {
  const idx = positions.map((p, i) => (p.v2 && p.redeemable && p.size > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return positions;
  try {
    const out = await publicClient.multicall({
      contracts: idx.map((i) => ({
        address: V2_POSITION_MANAGER_ADDRESS,
        abi: payoutAbi,
        functionName: "getPayout" as const,
        args: [BigInt(positions[i].asset), BigInt(Math.round(positions[i].size * 1e6))] as const,
      })),
      allowFailure: true,
    });
    const next = positions.slice();
    idx.forEach((i, k) => {
      const p = positions[i];
      const r = out[k];
      if (r.status !== "success") next[i] = { ...p, redeemable: false };
      else next[i] = { ...p, curPrice: Number(r.result as bigint) / Math.max(1, Math.round(p.size * 1e6)) };
    });
    return next;
  } catch {
    return positions;
  }
}

/** The user's live Polymarket positions (Data API v2, straight from the browser). One shared query: Perfil and the auto-collector read the same data. */
export function usePositions(refetchInterval = 20_000) {
  const { status } = useWallet();
  const { walletAddress } = useTrading();
  return useQuery({
    queryKey: ["positions", walletAddress],
    enabled: status === "connected" && !!walletAddress,
    refetchInterval,
    queryFn: async () => valueV2OnChain(await fetchPositions(walletAddress!)),
  });
}
