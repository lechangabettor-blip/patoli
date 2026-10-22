"use client";

import { useQuery } from "@tanstack/react-query";
import type { Game } from "@/lib/polymarket/gamma";
import type { LeagueId } from "@/lib/polymarket/leagues";

export function useGames(league: LeagueId) {
  return useQuery({
    queryKey: ["games", league],
    queryFn: async (): Promise<Game[]> => {
      const r = await fetch(`/api/games?league=${league}`);
      if (!r.ok) throw new Error("No pudimos cargar los partidos");
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export type PriceMap = Record<string, { bid: number | null; ask: number | null; mid: number | null }>;

/** Order-book prices for a set of tokens. `intervalMs` 2 s while a game is in play, 5 s prematch. */
export function usePrices(tokenIds: string[], intervalMs = 5_000) {
  const key = tokenIds.slice().sort().join(",");
  return useQuery({
    queryKey: ["prices", key],
    enabled: tokenIds.length > 0,
    refetchInterval: intervalMs,
    staleTime: Math.min(3_000, intervalMs - 500),
    queryFn: async (): Promise<PriceMap> => {
      const r = await fetch("/api/prices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenIds }),
      });
      if (!r.ok) return {};
      return r.json();
    },
  });
}
