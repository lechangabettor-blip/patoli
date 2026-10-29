"use client";

import { useSyncExternalStore } from "react";
import type { Selection } from "@/components/GameCard";

/**
 * One bet sheet for the whole app. Any button (game card, ladder row, Súbaseee/Bájeseee on a feed
 * card) calls `openBet`; `BetSheetHost`, mounted once per layout, renders it. Before this every
 * feed card carried its own sheet + portal + animation tree (forty of them on Inicio).
 */
let current: Selection | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openBet(sel: Selection): void {
  current = sel;
  emit();
}

export function closeBet(): void {
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useBetSelection(): Selection | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
