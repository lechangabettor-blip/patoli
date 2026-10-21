"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "@/providers/MeProvider";
import { useTrading } from "@/providers/TradingProvider";
import { usePositions } from "@/hooks/usePositions";
import { useSyncBets, useUser } from "@/hooks/useSocial";
import { useNow } from "@/hooks/useNow";

const SYNC_GAP_MS = 60_000;
const RETRY_GAP_MS = 10 * 60_000;
const GAME_OVER_AFTER_MS = 90 * 60_000;

/** What the last automatic collection did — Perfil shows it for a moment. */
export interface AutoRedeemNote {
  usd: number;
  at: number;
}

/**
 * Keeps a logged-in user's record current without them doing anything:
 *  - when one of their open bets is past the 90-minute mark, pull the indexer (which
 *    settles from the chain) so "ganada/perdida" shows the moment Polymarket resolves,
 *    instead of waiting for the cron;
 *  - when Polymarket reports winnings ready to redeem, collect them silently (one
 *    gasless signature, no popup) and refresh the balance.
 * Mounted once in the tabs layout; renders nothing.
 */
export default function AutoSettle() {
  const { me } = useMe();
  const { isReady, redeem } = useTrading();
  const qc = useQueryClient();
  const syncBets = useSyncBets();
  const positions = usePositions(60_000);
  const mine = useUser(me?.handle ?? null);
  const now = useNow()?.getTime() ?? 0;

  const lastSync = useRef(0);
  const attempted = useRef(new Map<string, number>());

  // 1. Open bets whose game should be over → sync, once a minute while any is pending.
  const dueOpen = (mine.data?.bets ?? []).some(
    (b) => b.kind !== "battle" && b.status === "open" && !!b.kickoff && now > 0 && now - Date.parse(b.kickoff) > GAME_OVER_AFTER_MS,
  );
  useEffect(() => {
    if (!dueOpen || Date.now() - lastSync.current < SYNC_GAP_MS) return;
    lastSync.current = Date.now();
    void syncBets([0]);
  }, [dueOpen, now, syncBets]);

  // 2. Winnings ready → collect them. Keyed by the set of markets so one attempt covers a poll cycle.
  const redeemables = (positions.data ?? []).filter((p) => p.redeemable && p.size > 0);
  const key = redeemables.map((p) => p.conditionId).sort().join(",");
  const usd = redeemables.reduce((s, p) => s + (p.curPrice >= 0.99 ? p.size : 0), 0);
  const negRisk = redeemables.filter((p) => p.negativeRisk).map((p) => p.conditionId).join(",");
  useEffect(() => {
    if (!isReady || !key) return;
    const last = attempted.current.get(key) ?? 0;
    if (Date.now() - last < RETRY_GAP_MS) return;
    attempted.current.set(key, Date.now());
    const neg = new Set(negRisk.split(",").filter(Boolean));
    const targets = key.split(",").map((conditionId) => ({ conditionId: conditionId as `0x${string}`, negRisk: neg.has(conditionId) }));
    void redeem(targets)
      .then(() => {
        qc.setQueryData<AutoRedeemNote>(["autoRedeem"], { usd, at: Date.now() });
        qc.invalidateQueries({ queryKey: ["positions"] });
        qc.invalidateQueries({ queryKey: ["balances"] });
        void syncBets([0]);
      })
      .catch(() => {
        /* Perfil keeps the manual Cobrar button as the fallback */
      });
  }, [isReady, key, negRisk, usd, redeem, qc, syncBets]);

  return null;
}
