"use client";

/**
 * One websocket to Polymarket's market channel for the whole app. Components say which outcome
 * tokens they are looking at (`subscribe`); the socket keeps the best bid/ask of each one fresh
 * the instant the book changes. `usePrices` overlays these on top of its slower REST poll, so
 * odds move in well under a second and the poll becomes a safety net.
 *
 * Verified against the live feed (2026-10-28): on subscribe a `book` snapshot per asset
 * (bids/asks arrays), then `price_change` messages whose `price_changes[]` carry
 * `best_bid` / `best_ask` per `asset_id` (both tokens of the market arrive).
 */

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MAX_ASSETS = 500;

export interface LiveQuote {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** ms epoch of the last update */
  at: number;
}

const wanted = new Map<string, number>(); // tokenId → refcount
const quotes = new Map<string, LiveQuote>();
const listeners = new Set<() => void>();
let version = 0;
let ws: WebSocket | null = null;
let connectedKey = "";
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1_000;
let open = false;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setQuote(id: string, bid: number | null, ask: number | null) {
  if (bid == null && ask == null) return;
  const prev = quotes.get(id);
  const b = bid ?? prev?.bid ?? null;
  const a = ask ?? prev?.ask ?? null;
  quotes.set(id, { bid: b, ask: a, mid: a != null && b != null ? (a + b) / 2 : (a ?? b), at: Date.now() });
  version++;
  if (!notifyTimer) {
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const l of listeners) l();
    }, 80); // batch bursts into one render
  }
}

function onMessage(ev: MessageEvent) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(ev.data));
  } catch {
    return; // "PONG" and friends
  }
  const msgs = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
  for (const m of msgs) {
    if (m.event_type === "book") {
      const id = String(m.asset_id ?? "");
      const bids = (m.bids as { price: string }[] | undefined) ?? [];
      const asks = (m.asks as { price: string }[] | undefined) ?? [];
      const bid = bids.reduce<number | null>((best, l) => (num(l.price) != null && (best == null || Number(l.price) > best) ? Number(l.price) : best), null);
      const ask = asks.reduce<number | null>((best, l) => (num(l.price) != null && (best == null || Number(l.price) < best) ? Number(l.price) : best), null);
      if (id) setQuote(id, bid, ask);
    } else if (m.event_type === "price_change") {
      for (const c of (m.price_changes as Record<string, unknown>[] | undefined) ?? []) {
        const id = String(c.asset_id ?? "");
        if (id && wanted.has(id)) setQuote(id, num(c.best_bid), num(c.best_ask));
      }
    }
  }
}

function connect(ids: string[]) {
  if (typeof WebSocket === "undefined") return;
  ws?.close();
  ws = null;
  open = false;
  if (ids.length === 0) {
    connectedKey = "";
    return;
  }
  const socket = new WebSocket(WS_URL);
  ws = socket;
  connectedKey = ids.join(",");
  socket.onopen = () => {
    if (ws !== socket) return;
    open = true;
    backoffMs = 1_000;
    socket.send(JSON.stringify({ assets_ids: ids, type: "market" }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => socket.readyState === 1 && socket.send("PING"), 10_000);
    console.info(`[patoli] prices socket open · ${ids.length} tokens`);
  };
  socket.onmessage = onMessage;
  socket.onclose = () => {
    if (ws !== socket) return;
    open = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    ws = null;
    connectedKey = "";
    if (wanted.size > 0) {
      setTimeout(() => scheduleSync(), backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  };
  socket.onerror = () => socket.close();
}

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const ids = [...wanted.keys()].slice(0, MAX_ASSETS).sort();
    const key = ids.join(",");
    if (key !== connectedKey) connect(ids);
  }, 250); // many components mount at once: one connection for all of them
}

/** Watch these tokens; returns the unsubscribe. */
export function subscribe(tokenIds: string[]): () => void {
  for (const id of tokenIds) wanted.set(id, (wanted.get(id) ?? 0) + 1);
  scheduleSync();
  return () => {
    for (const id of tokenIds) {
      const n = (wanted.get(id) ?? 1) - 1;
      if (n <= 0) wanted.delete(id);
      else wanted.set(id, n);
    }
    scheduleSync();
  };
}

export function onChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const getVersion = () => version;
export const getServerVersion = () => 0;
export const isOpen = () => open;
export const getQuote = (id: string) => quotes.get(id);
/** The quote only if it was updated within `maxAgeMs` (stale sockets must not beat the REST poll). */
export function getFreshQuote(id: string, maxAgeMs: number): LiveQuote | undefined {
  const q = quotes.get(id);
  return q && Date.now() - q.at <= maxAgeMs ? q : undefined;
}
