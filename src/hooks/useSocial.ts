"use client";

import { useQuery } from "@tanstack/react-query";
import { useMe } from "@/providers/MeProvider";
import type { FeedItem, PublicProfile } from "@/types/social";
import { LEAGUE_BY_ID, isLeagueId } from "@/lib/polymarket/leagues";
import type { TicketData } from "@/components/Ticket";

export function useFeed(scope: "all" | "following") {
  const { getToken } = useMe();
  return useQuery({
    queryKey: ["feed", scope],
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ items: FeedItem[]; demo: boolean }> => {
      const headers: Record<string, string> = {};
      if (scope === "following") {
        const t = await getToken();
        if (t) headers.authorization = `Bearer ${t}`;
      }
      const r = await fetch(`/api/feed?scope=${scope}`, { headers });
      if (!r.ok) throw new Error("feed");
      return r.json();
    },
  });
}

export function useUsers(q: string) {
  return useQuery({
    queryKey: ["users", q],
    staleTime: 20_000,
    queryFn: async (): Promise<{ items: PublicProfile[]; demo: boolean }> => {
      const r = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error("users");
      return r.json();
    },
  });
}

export function useUser(handle: string | null) {
  const { getToken, me } = useMe();
  return useQuery({
    queryKey: ["user", handle, me?.id ?? null],
    enabled: !!handle,
    queryFn: async (): Promise<{ profile: PublicProfile; bets: FeedItem[]; demo: boolean } | null> => {
      const headers: Record<string, string> = {};
      const t = await getToken();
      if (t) headers.authorization = `Bearer ${t}`;
      const r = await fetch(`/api/users/${encodeURIComponent(handle!)}`, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("user");
      return r.json();
    },
  });
}

/** Feed item → shareable ticket. */
export function ticketFromItem(item: FeedItem): TicketData {
  const league = isLeagueId(item.league) ? LEAGUE_BY_ID[item.league] : null;
  return {
    handle: item.user.handle,
    avatar: item.user.avatar,
    league: league?.label ?? "Polymarket",
    leagueEmoji: league?.emoji,
    matchup: item.event,
    selection: item.selection,
    market: item.market === "ML" ? "Ganador" : item.market === "Spread" ? "Hándicap" : item.market === "Total" ? "Total" : "Pick",
    odds: item.odds,
    stake: item.stake,
    payout: item.payout,
    placedAt: item.placedAt,
    status: item.status,
    proof: item.proof ?? undefined,
    kickoff: item.kickoff ?? undefined,
  };
}
