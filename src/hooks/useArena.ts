"use client";

import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import { useMe } from "@/providers/MeProvider";
import { useWallet } from "@/providers/WalletContext";
import { isRealtimeConfigured, supabaseBrowser } from "@/lib/supabase/browser";
import { ARENA_DOMAIN, ARENA_TYPES, commitHash, isArenaConfigured, toUnits, type MatchStruct, type Move } from "@/lib/arena/typed-data";
import type { MatchPlayers, MatchRow, RoundRow } from "@/lib/arena/engine";

export interface ArenaMe {
  balance: number;
  free: number;
  waiting: number;
  pending: { amount: number; to: string; readyAt: number } | null;
  nonce: string;
  matchId: string | null;
  matchStatus: string | null;
}
export interface MatchState {
  match: MatchRow;
  rounds: RoundRow[];
  players?: MatchPlayers;
  balances?: { a: number; b: number };
}

/** Local secrets (move + salt per round) so a reload mid-round can still reveal. */
const secretKey = (matchId: string, round: number) => `arena:${matchId}:${round}`;
export function saveSecret(matchId: string, round: number, move: Move, salt: Hex) {
  try {
    localStorage.setItem(secretKey(matchId, round), JSON.stringify({ move, salt }));
  } catch {
    /* private mode */
  }
}
export function loadSecret(matchId: string, round: number): { move: Move; salt: Hex } | null {
  try {
    const raw = localStorage.getItem(secretKey(matchId, round));
    return raw ? (JSON.parse(raw) as { move: Move; salt: Hex }) : null;
  } catch {
    return null;
  }
}

/**
 * Pre-signed commits: when a round opens we sign all three possible moves in the
 * background (salt + hash + Magic signature each). The tap then only sends the one
 * chosen — no signing round trip between the finger and the screen.
 */
type Prepared = Record<Move, { salt: Hex; hash: Hex; sig: Hex }>;
const prepared = new Map<string, Prepared | Promise<Prepared>>();
const prepKey = (matchId: string, round: number) => `${matchId}:${round}`;

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function useArenaMe() {
  const { getToken, me } = useMe();
  return useQuery({
    queryKey: ["arena-me", me?.id ?? null],
    enabled: isArenaConfigured() && !!me,
    refetchInterval: 10_000,
    queryFn: async (): Promise<ArenaMe | null> => {
      const t = await getToken();
      if (!t) return null;
      const r = await fetch("/api/arena/me", { headers: { authorization: `Bearer ${t}` } });
      if (!r.ok) return null;
      return r.json();
    },
  });
}

/** Match state + realtime invalidation (Supabase Realtime, read-only). */
export function useArenaMatch(matchId: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["arena-match", matchId],
    enabled: !!matchId,
    refetchInterval: 3_000, // safety net if realtime drops
    queryFn: async (): Promise<MatchState | null> => {
      const r = await fetch(`/api/arena/match/${matchId}`, { cache: "no-store" });
      if (!r.ok) return null;
      return r.json();
    },
  });
  useEffect(() => {
    if (!matchId || !isRealtimeConfigured()) return;
    const sb = supabaseBrowser();
    const ch = sb
      .channel(`arena:${matchId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "arena_matches", filter: `id=eq.${matchId}` }, () => {
        qc.invalidateQueries({ queryKey: ["arena-match", matchId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "arena_rounds", filter: `match_id=eq.${matchId}` }, () => {
        qc.invalidateQueries({ queryKey: ["arena-match", matchId] });
      })
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [matchId, qc]);
  return q;
}

/** Authenticated calls + EIP-712 signing through the Magic signer. */
export function useArenaActions() {
  const { getToken } = useMe();
  const { ethersSigner, eoaAddress } = useWallet();
  const qc = useQueryClient();

  const call = useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const t = await getToken();
      if (!t) throw new Error("Inicia sesión");
      const r = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}`, "content-type": "application/json" } });
      const j = (await r.json().catch(() => ({}))) as T & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `error ${r.status}`);
      return j;
    },
    [getToken],
  );

  // ethers v5 wants strings for uint256 values; viem typed-data shapes map 1:1 otherwise
  const sign = useCallback(
    async (primaryType: keyof typeof ARENA_TYPES, message: Record<string, unknown>): Promise<Hex> => {
      if (!ethersSigner) throw new Error("Sin firma disponible");
      const value = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
      const types = { [primaryType]: [...ARENA_TYPES[primaryType]] };
      return (await ethersSigner._signTypedData(ARENA_DOMAIN, types, value)) as Hex;
    },
    [ethersSigner],
  );

  const refresh = useCallback(
    (matchId?: string | null) => {
      qc.invalidateQueries({ queryKey: ["arena-me"] });
      if (matchId) qc.invalidateQueries({ queryKey: ["arena-match", matchId] });
    },
    [qc],
  );

  return {
    joinLobby: async (stake: number) => {
      const r = await call<{ matchId: string | null; queued: boolean }>("/api/arena/lobby", { method: "POST", body: JSON.stringify({ stake }) });
      refresh(r.matchId);
      return r;
    },
    leaveLobby: () => call("/api/arena/lobby", { method: "DELETE" }),
    lobbyStatus: () => call<{ queued: boolean; waiting: number; matchId: string | null }>("/api/arena/lobby"),
    signMatch: async (m: MatchStruct) => {
      const sig = await sign("Match", { ...m });
      await call(`/api/arena/match/${m.id}/sign`, { method: "POST", body: JSON.stringify({ sig }) });
      refresh(m.id);
    },
    /** Sign the three possible moves for this round ahead of time (idempotent). */
    prepare: (matchId: Hex, round: number): Promise<Prepared> => {
      const key = prepKey(matchId, round);
      const hit = prepared.get(key);
      if (hit) return Promise.resolve(hit);
      if (!eoaAddress) return Promise.reject(new Error("Sin wallet"));
      const p = (async () => {
        const out = {} as Prepared;
        for (const move of [1, 2, 3] as Move[]) {
          const salt = randomSalt();
          const hash = commitHash(matchId, round, eoaAddress as Hex, move, salt);
          const sig = await sign("Commit", { matchId, round, hash });
          out[move] = { salt, hash, sig };
        }
        prepared.set(key, out);
        return out;
      })();
      prepared.set(key, p);
      p.catch(() => prepared.delete(key));
      return p;
    },
    commit: async (matchId: Hex, round: number, move: Move) => {
      if (!eoaAddress) throw new Error("Sin wallet");
      const key = prepKey(matchId, round);
      let entry: { salt: Hex; hash: Hex; sig: Hex };
      const hit = prepared.get(key);
      if (hit) entry = (await hit)[move];
      else {
        const salt = randomSalt();
        const hash = commitHash(matchId, round, eoaAddress as Hex, move, salt);
        const sig = await sign("Commit", { matchId, round, hash });
        entry = { salt, hash, sig };
      }
      saveSecret(matchId, round, move, entry.salt);
      await call(`/api/arena/match/${matchId}/commit`, { method: "POST", body: JSON.stringify({ round, hash: entry.hash, sig: entry.sig }) });
      prepared.delete(key);
      refresh(matchId);
    },
    reveal: async (matchId: string, round: number) => {
      const s = loadSecret(matchId, round);
      if (!s) throw new Error("No encontré tu jugada en este dispositivo");
      await call(`/api/arena/match/${matchId}/reveal`, { method: "POST", body: JSON.stringify({ round, move: s.move, salt: s.salt }) });
      refresh(matchId);
    },
    sweep: async () => {
      const r = await call<{ swept: number; tx?: string; balance: number }>("/api/arena/sweep", { method: "POST" });
      refresh();
      return r;
    },
    rematch: async (matchId: string) => {
      const r = await call<{ match: unknown }>(`/api/arena/match/${matchId}/rematch`, { method: "POST" });
      refresh(matchId);
      return r;
    },
    tick: async (matchId: string) => {
      await call(`/api/arena/match/${matchId}/tick`, { method: "POST" });
      refresh(matchId);
    },
    withdraw: async (amountUsd: number, nonce: string, wallet: Hex) => {
      if (!eoaAddress) throw new Error("Sin wallet");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const sig = await sign("Withdraw", { player: eoaAddress, to: wallet, amount: toUnits(amountUsd), nonce: BigInt(nonce), deadline: BigInt(deadline) });
      const r = await call<{ tx: string }>("/api/arena/withdraw", { method: "POST", body: JSON.stringify({ amount: amountUsd, deadline, sig }) });
      refresh();
      return r.tx;
    },
    refresh,
  };
}
