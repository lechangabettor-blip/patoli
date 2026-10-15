"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getMagic } from "@/lib/magic";
import { useWallet } from "./WalletContext";
import { useTrading } from "./TradingProvider";
import type { MeProfile } from "@/types/social";

/**
 * The caller's Patoli profile (DB identity), created on first login by posting
 * the Magic DID token + deposit wallet to /api/me. Also hands out the DID
 * token for other authenticated calls (follow, reactions).
 */
interface MeContextType {
  me: MeProfile | null;
  status: "idle" | "loading" | "ready" | "unavailable";
  /** Fresh Magic DID token (short-lived) for Authorization: Bearer */
  getToken: () => Promise<string | null>;
  refresh: () => Promise<void>;
  follow: (handle: string, follow: boolean) => Promise<boolean>;
}

const MeContext = createContext<MeContextType>({
  me: null,
  status: "idle",
  getToken: async () => null,
  refresh: async () => {},
  follow: async () => false,
});

export const useMe = () => useContext(MeContext);

export function MeProvider({ children }: { children: ReactNode }) {
  const { status: auth, eoaAddress } = useWallet();
  const { walletAddress } = useTrading();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [status, setStatus] = useState<MeContextType["status"]>("idle");
  const inflight = useRef<string | null>(null);

  const getToken = useCallback(async () => {
    const magic = getMagic();
    if (!magic) return null;
    try {
      return await magic.user.getIdToken({ lifespan: 300 });
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (auth !== "connected" || !eoaAddress || !walletAddress) return;
    const key = `${eoaAddress}:${walletAddress}`;
    if (inflight.current === key) return;
    inflight.current = key;
    await Promise.resolve(); // leave the caller's render/effect tick before touching state
    setStatus("loading");
    try {
      const token = await getToken();
      if (!token) throw new Error("no token");
      const r = await fetch("/api/me", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ walletAddress }),
      });
      if (r.status === 503) {
        setStatus("unavailable");
        return;
      }
      if (!r.ok) throw new Error(`me ${r.status}`);
      setMe((await r.json()) as MeProfile);
      setStatus("ready");
    } catch (e) {
      console.warn("[patoli] profile sync failed", e);
      setStatus("unavailable");
    } finally {
      inflight.current = null;
    }
  }, [auth, eoaAddress, walletAddress, getToken]);

  // Sync once we know both the login and the vault address (async; state is
  // set in the callbacks, not in the effect body)
  useEffect(() => {
    if (auth !== "connected" || !walletAddress) return;
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [auth, walletAddress, refresh]);

  // Logged-out view is derived, so no state reset is needed on logout
  const visibleMe = auth === "connected" ? me : null;
  const visibleStatus: MeContextType["status"] = auth === "connected" ? status : "idle";

  const follow = useCallback(
    async (handle: string, want: boolean) => {
      const token = await getToken();
      if (!token) return false;
      const r = await fetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ handle, follow: want }),
      });
      return r.ok;
    },
    [getToken],
  );

  const value = useMemo<MeContextType>(
    () => ({ me: visibleMe, status: visibleStatus, getToken, refresh, follow }),
    [visibleMe, visibleStatus, getToken, refresh, follow],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}
