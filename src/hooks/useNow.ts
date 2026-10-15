"use client";

import { useSyncExternalStore } from "react";

let listeners = new Set<() => void>();
let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      listeners = new Set();
    }
  };
}

/**
 * Client-only clock, refreshed every 30 s. Returns null during server
 * prerender so relative-time labels never bake a timestamp into static HTML
 * (Next.js Cache Components forbids reading the clock while prerendering).
 */
export function useNow(): Date | null {
  const ms = useSyncExternalStore(
    subscribe,
    () => now || Date.now(),
    () => 0,
  );
  return ms ? new Date(ms) : null;
}
