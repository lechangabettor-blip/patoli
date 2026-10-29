"use client";

import type { LiveScore } from "@/lib/scores";
import type { GameDetail } from "@/lib/polymarket/game-detail";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getFreshQuote, getServerVersion, getVersion, isOpen, onChange, subscribe } from "@/lib/polymarket/price-socket";
import { fetchPrices, type PriceMap } from "@/lib/polymarket/public-api";
import type { Game } from "@/lib/polymarket/gamma";
import type { LeagueId } from "@/lib/polymarket/leagues";

export type { PriceMap };

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

export const gameDetailKey = (slug: string) => ["game-detail", slug] as const;

export async function fetchGameDetail(slug: string): Promise<GameDetail | null> {
  const r = await fetch(`/api/games/${encodeURIComponent(slug)}/markets`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("game");
  return r.json();
}

/** Every market of one game (the game page). */
export function useGameDetail(slug: string) {
  return useQuery({
    queryKey: gameDetailKey(slug),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: () => fetchGameDetail(slug),
  });
}

/** Live scores for a league's in-play games, every 10 s while any game is live. */
export function useScores(league: LeagueId, enabled: boolean) {
  return useQuery({
    queryKey: ["scores", league],
    enabled,
    refetchInterval: 10_000,
    staleTime: 8_000,
    queryFn: async (): Promise<Record<string, LiveScore>> => {
      const r = await fetch(`/api/scores?league=${league}`);
      return r.ok ? r.json() : {};
    },
  });
}

/** Order-book prices for a set of tokens. `intervalMs` 2 s while a game is in play, 5 s prematch. */
/** A websocket quote is trusted this long without a newer message; past it the REST poll wins. */
const SOCKET_FRESH_MS = 60_000;

/**
 * Best bid/ask per token. Two sources: Polymarket's websocket (pushes every book change; see
 * price-socket.ts) overlaid on a REST poll that becomes a slow safety net while the socket is
 * open. Components keep reading `.data[tokenId].ask` exactly as before.
 */
export function usePrices(tokenIds: string[], intervalMs = 5_000) {
  const key = tokenIds.slice().sort().join(",");
  const version = useSyncExternalStore(onChange, getVersion, getServerVersion);
  useEffect(() => (key ? subscribe(key.split(",")) : undefined), [key]);
  const live = version > 0 && isOpen();
  const q = useQuery({
    queryKey: ["prices", key],
    enabled: tokenIds.length > 0,
    refetchInterval: live ? Math.max(intervalMs, 20_000) : intervalMs,
    staleTime: Math.min(3_000, intervalMs - 500),
    queryFn: () => fetchPrices(tokenIds), // straight from the CLOB; our proxy is the fallback
  });
  const data = useMemo(() => {
    if (!key) return q.data;
    let out: PriceMap | undefined;
    for (const id of key.split(",")) {
      const s = getFreshQuote(id, SOCKET_FRESH_MS);
      if (!s) continue;
      out ??= { ...(q.data ?? {}) };
      out[id] = { bid: s.bid, ask: s.ask, mid: s.mid };
    }
    return out ?? q.data;
    // version is the socket's change counter: it is what makes this recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, key, version]);
  return { ...q, data };
}
