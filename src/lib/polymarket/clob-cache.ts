"use client";

/**
 * Per-session shortcuts for the order path (see usePlaceBet.prepare): once a bet has gone through,
 * the on-chain approval check and the CLOB balance re-sync are skipped. Anything that changes the
 * wallet's collateral outside an order (a wrap, a redeem) must forget the balance shortcut, or the
 * next order is sent against the CLOB's stale cached balance and rejected.
 */
let approvalsOk = false;
let collateralSynced = false;

export const clobCache = {
  get approvalsOk() {
    return approvalsOk;
  },
  set approvalsOk(v: boolean) {
    approvalsOk = v;
  },
  get collateralSynced() {
    return collateralSynced;
  },
  set collateralSynced(v: boolean) {
    collateralSynced = v;
  },
};

/** Collateral changed outside an order: make the next order re-sync the CLOB balance first. */
export function forgetCollateralSync(): void {
  collateralSynced = false;
}
