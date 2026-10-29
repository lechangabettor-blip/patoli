"use client";

import type { Selection } from "@/components/GameCard";

/**
 * The pick a logged-out user tapped, kept across the login round trip (email OTP modal or the
 * Google redirect, same tab) so the bet sheet reopens on the same outcome when they come back.
 * The game page can rebuild any selection from its own markets, so that is where we send them.
 */
const KEY = "patoli.pick";
const TTL_MS = 20 * 60_000;

export interface PendingPick {
  slug: string;
  marketId: string;
  tokenId: string;
  source?: Selection["source"];
  at: number;
}

export function stashPick(sel: Selection): void {
  try {
    const p: PendingPick = { slug: sel.game.slug, marketId: sel.market.id, tokenId: sel.outcome.tokenId, source: sel.source, at: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: the user simply finds the game again */
  }
}

/** Where to send the user after login so the pick can reopen. */
export const pickReturnPath = (sel: Selection) => `/deportes/partido/${sel.game.slug}`;

/** The stashed pick for this game, if any and still fresh. Does not remove it; call clearPick once it opened. */
export function peekPick(slug: string): PendingPick | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingPick;
    if (Date.now() - p.at > TTL_MS || p.slug !== slug) {
      if (Date.now() - p.at > TTL_MS) sessionStorage.removeItem(KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

export function clearPick(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
