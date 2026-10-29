"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "@/providers/MeProvider";
import { useTrading } from "@/providers/TradingProvider";
import { usePositions } from "@/hooks/usePositions";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { useSyncBets, useUser } from "@/hooks/useSocial";
import { useNow } from "@/hooks/useNow";
import { RPC_READ_ERROR, redeemTargetsFrom, type RedeemTarget } from "@/lib/polymarket/v2";

const SYNC_GAP_MS = 60_000;
/** Past this age an open bet is synced every SLOW_SYNC_GAP_MS instead: Protocol V2 canaries took 6–17 h to resolve. */
const LONG_OPEN_AFTER_MS = 4 * 60 * 60_000;
const SLOW_SYNC_GAP_MS = 10 * 60_000;
const RETRY_GAP_MS = 10 * 60_000;
const GAME_OVER_AFTER_MS = 90 * 60_000;
/** Failed batches for one set of winnings before the automatic collector leaves it to the manual Cobrar button. */
const MAX_FAILURES = 3;

/** What the last automatic collection did — Perfil shows it for a moment. */
export interface AutoRedeemNote {
  usd: number;
  at: number;
}

/** What the last automatic conversion did (USDC that landed → pUSD). */
export interface AutoWrapNote {
  usd: number;
  at: number;
}

/**
 * Keeps a logged-in user's money and record current without them doing anything:
 *  - when one of their open bets is past the 90-minute mark, pull the indexer (which
 *    settles from the chain) so "ganada/perdida" shows the moment Polymarket resolves,
 *    instead of waiting for the cron;
 *  - when Polymarket reports winnings ready to redeem, collect them silently (one
 *    gasless signature, no popup) and refresh the balance;
 *  - when USDC lands in the deposit wallet, wrap it to pUSD silently (same gasless batch as the
 *    Convertir button) so the header never shows $0.00 after a deposit.
 * Mounted once in the tabs layout; renders nothing.
 */
export default function AutoSettle() {
  const { me } = useMe();
  const { isReady, step, redeem, wrapUsdc, setupTrading } = useTrading();
  const qc = useQueryClient();
  const syncBets = useSyncBets();
  const positions = usePositions(60_000);
  const { pendingUsdcRaw } = useUsdcBalance();
  const mine = useUser(me?.handle ?? null);
  const now = useNow()?.getTime() ?? 0;

  const lastSync = useRef(0);
  const attempted = useRef(new Map<string, number>());
  const failed = useRef(new Map<string, number>());
  const wrapAttempted = useRef(new Map<string, number>());

  // 1. Open bets whose game should be over → sync once a minute for the first hours, then every
  //    ten minutes (no reason to poll the indexer all night for a market Polymarket resolves late).
  const openAges = (mine.data?.bets ?? [])
    .filter((b) => b.kind !== "battle" && b.status === "open" && !!b.kickoff && now > 0)
    .map((b) => now - Date.parse(b.kickoff as string))
    .filter((age) => age > GAME_OVER_AFTER_MS);
  const dueOpen = openAges.length > 0;
  const recentlyDue = openAges.some((age) => age < LONG_OPEN_AFTER_MS);
  useEffect(() => {
    if (!dueOpen || Date.now() - lastSync.current < (recentlyDue ? SYNC_GAP_MS : SLOW_SYNC_GAP_MS)) return;
    lastSync.current = Date.now();
    void syncBets([0]);
  }, [dueOpen, recentlyDue, now, syncBets]);

  // 2. Winnings ready → collect them. Keyed by the set of markets so one attempt covers a poll cycle.
  //    `redeemable` also covers LOST positions (Data API v2); those are worth $0 and burning them would
  //    spend a relayer transaction for nothing (100/day on the Unverified tier), so only value is collected.
  const redeemables = (positions.data ?? []).filter((p) => p.redeemable && p.size > 0 && p.curPrice > 0.01);
  // Serialized so the effect keys on content, not on array identity (positions re-poll every 60 s).
  const targetsKey = JSON.stringify(redeemTargetsFrom(redeemables));
  const usd = redeemables.reduce((s, p) => s + (p.curPrice >= 0.99 ? p.size : 0), 0);
  useEffect(() => {
    if (!isReady || targetsKey === "[]") return;
    const last = attempted.current.get(targetsKey) ?? 0;
    if (Date.now() - last < RETRY_GAP_MS) return;
    // After MAX_FAILURES batches for the same set, stop spending relayer transactions on it: Perfil
    // keeps the manual Cobrar button, and any change in the set (new winnings) starts over.
    if ((failed.current.get(targetsKey) ?? 0) >= MAX_FAILURES) return;
    attempted.current.set(targetsKey, Date.now());
    void redeem(JSON.parse(targetsKey) as RedeemTarget[])
      .then((hash) => {
        failed.current.delete(targetsKey);
        // No hash = nothing was submitted (every V2 position already emptied elsewhere): refresh the
        // positions, but do not announce a collection that did not happen.
        if (!hash) {
          qc.invalidateQueries({ queryKey: ["positions"] });
          return;
        }
        qc.setQueryData<AutoRedeemNote>(["autoRedeem"], { usd, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["balances"] });
        void syncBets([0]);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string } | null)?.name === RPC_READ_ERROR) return; // Polygon unreadable: try again later, no strike
        failed.current.set(targetsKey, (failed.current.get(targetsKey) ?? 0) + 1);
      });
  }, [isReady, targetsKey, usd, redeem, qc, syncBets]);

  // 3. USDC.e that just landed → pUSD. A never-activated account that received money is activated first
  //    (deposit wallet, keys, approvals — all silent signatures), so "deposit, then bet" is one tap too.
  //    One attempt per amount every 10 min; the Convertir card stays as the fallback.
  useEffect(() => {
    if (pendingUsdcRaw <= 0n) return;
    if (!isReady && step !== "idle") return; // an activation started elsewhere (bet sheet, Perfil) is in flight
    const amountKey = pendingUsdcRaw.toString();
    if (Date.now() - (wrapAttempted.current.get(amountKey) ?? 0) < RETRY_GAP_MS) return;
    wrapAttempted.current.set(amountKey, Date.now());
    const wrapped = Number(pendingUsdcRaw) / 1e6;
    (async () => {
      if (!isReady) await setupTrading();
      await wrapUsdc(pendingUsdcRaw);
    })()
      .then(() => {
        qc.setQueryData<AutoWrapNote>(["autoWrap"], { usd: wrapped, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["balances"] });
      })
      .catch(() => {
        /* Perfil keeps the manual Convertir card */
      });
  }, [isReady, step, pendingUsdcRaw, wrapUsdc, setupTrading, qc]);

  return null;
}
