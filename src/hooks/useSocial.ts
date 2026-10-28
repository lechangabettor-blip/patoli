"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "@/providers/MeProvider";
import type { FeedItem, MoneyRow, PublicProfile } from "@/types/social";
import { LEAGUE_BY_ID, isLeagueId } from "@/lib/polymarket/leagues";
import type { TicketData } from "@/components/Ticket";

export function useFeed(scope: "all" | "following") {
  const { getToken } = useMe();
  return useQuery({
    queryKey: ["feed", scope],
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ items: FeedItem[]; demo: boolean }> => {
      // The token is optional: it unlocks "following" and marks which picks the viewer already 🔥'd.
      const headers: Record<string, string> = {};
      const t = await getToken();
      if (t) headers.authorization = `Bearer ${t}`;
      const r = await fetch(`/api/feed?scope=${scope}`, { headers });
      if (!r.ok) throw new Error("feed");
      return r.json();
    },
  });
}

export function useUsers(q: string, scope?: "rail") {
  return useQuery({
    queryKey: ["users", q, scope ?? null],
    staleTime: 20_000,
    queryFn: async (): Promise<{ items: PublicProfile[]; demo: boolean }> => {
      const r = await fetch(`/api/users?q=${encodeURIComponent(q)}${scope ? `&scope=${scope}` : ""}`);
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

/** The owner's own deposits, withdrawals and tips (Dinero tab). Only fetched when logged in. */
export function useMoney() {
  const { getToken, me } = useMe();
  return useQuery({
    queryKey: ["money", me?.id ?? null],
    enabled: !!me,
    staleTime: 30_000,
    queryFn: async (): Promise<MoneyRow[]> => {
      const t = await getToken();
      if (!t) return [];
      const r = await fetch("/api/me/money", { headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error("money");
      return ((await r.json()) as { rows: MoneyRow[] }).rows;
    },
  });
}

/** 🔥 a feed item (or take it back). Resolves to the fresh count, or null when the call failed. */
export function useReact() {
  const { getToken } = useMe();
  return useCallback(
    async (id: string, on: boolean, kind: "fire" | "tail" | "fade" = "fire"): Promise<{ fire: number; fired: boolean } | null> => {
      const t = await getToken();
      if (!t) return null;
      const r = await fetch("/api/react", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ id, on, kind }) });
      return r.ok ? r.json() : null;
    },
    [getToken],
  );
}

/**
 * Records a Súbaseee/Bájeseee after the order filled. The server only counts it once the indexer
 * has the viewer's fill (usePlaceBet pulls it at 1.5 s / 6 s / 15 s), so we retry on 202.
 */
export function useRecordTail() {
  const { getToken } = useMe();
  const qc = useQueryClient();
  return useCallback(
    async (betId: string, side: "tail" | "fade"): Promise<boolean> => {
      for (const delay of [2_500, 5_000, 8_000, 12_000, 20_000]) {
        await new Promise((r) => setTimeout(r, delay));
        const t = await getToken();
        if (!t) return false;
        const r = await fetch("/api/react", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ id: betId, on: true, kind: side }) });
        if (r.status === 202) continue;
        if (r.ok) {
          qc.invalidateQueries({ queryKey: ["feed"] });
          qc.invalidateQueries({ queryKey: ["user"] });
          return true;
        }
        return false;
      }
      return false;
    },
    [getToken, qc],
  );
}

/** Feed item → shareable ticket. */
export function ticketFromItem(item: FeedItem): TicketData {
  const league = isLeagueId(item.league) ? LEAGUE_BY_ID[item.league] : null;
  return {
    handle: item.user.handle,
    avatar: item.user.avatar,
    league: item.kind === "battle" ? "Batalla" : (league?.label ?? "Polymarket"),
    leagueEmoji: item.kind === "battle" ? "✊" : league?.emoji,
    matchup: item.kind === "battle" ? `vs @${item.battle?.opponent.handle ?? "rival"}` : item.event,
    selection: item.kind === "battle" ? `${item.battle?.result === "won" ? "Ganó" : item.battle?.result === "lost" ? "Perdió" : "Empate"} ${item.battle?.scoreMe}-${item.battle?.scoreThem}` : item.selection,
    market:
      item.market === "ML" ? "Ganador" : item.market === "Spread" ? "Hándicap" : item.market === "Total" ? "Total" : item.market === "BTTS" ? "Ambos anotan" : item.market === "Prop" ? "Prop de jugador" : item.market === "Batalla" ? "✊ Batalla" : "Pick",
    odds: item.odds,
    stake: item.stake,
    payout: item.payout,
    placedAt: item.placedAt,
    status: item.status,
    proof: item.proof ?? undefined,
    kickoff: item.kickoff ?? undefined,
  };
}

/**
 * Pull the indexer now (authenticated) and refresh everything that shows bets.
 * Polymarket's trade feed can lag a fill by a few seconds, so `sync` can retry
 * on a schedule: each pass re-runs the indexer and invalidates the queries.
 */
export function useSyncBets() {
  const { getToken, refresh } = useMe();
  const qc = useQueryClient();
  return useCallback(
    async (delaysMs: number[] = [0]) => {
      for (const delay of delaysMs) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          const t = await getToken();
          if (!t) return;
          await fetch("/api/me/sync", { method: "POST", headers: { authorization: `Bearer ${t}` } });
        } catch {
          /* best effort */
        }
        qc.invalidateQueries({ queryKey: ["user"] });
        qc.invalidateQueries({ queryKey: ["feed"] });
        void refresh();
      }
    },
    [getToken, refresh, qc],
  );
}
