"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { polygon } from "viem/chains";
import { hasAuthFlag, isMagicConfigured, loadSdk, setAuthFlag, type Sdk } from "@/lib/sdk";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";
import { WalletContext, type AuthStatus, type WalletContextType } from "./WalletContext";

const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });

/** Pages that always need the wallet stack: the user is about to log in, or is back from Google. */
const AUTH_PATH = /^\/(entrar|oauth)(\/|$)/;

/**
 * Wraps Magic (email OTP + Google) and exposes an ethers v5 signer, which is what Polymarket's
 * clients expect, plus a viem wallet client for everything else.
 *
 * The SDKs (~2.6 MB of JS) load on demand: when this browser logged in before (`patoli.auth`
 * flag), on the login pages, or when the user taps a login button. Anonymous readers of the feed
 * never download them and are "anonymous" at once instead of waiting on Magic.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const isDemo = !isMagicConfigured();
  const [status, setStatus] = useState<AuthStatus>(isDemo ? "anonymous" : "loading");
  const [eoaAddress, setEoaAddress] = useState<`0x${string}` | undefined>();
  const [email, setEmail] = useState<string | null>(null);
  const [sdk, setSdk] = useState<Sdk | null>(null);

  const ensureSdk = useCallback(async () => {
    const s = await loadSdk();
    setSdk(s);
    return s;
  }, []);

  const hydrateUser = useCallback(async (s: Sdk) => {
    if (!s.magic) return;
    const info = await s.magic.user.getInfo();
    const address = (info.wallets?.ethereum?.publicAddress ?? null) as `0x${string}` | null;
    setEoaAddress(address ?? undefined);
    setEmail(info.email ?? null);
    setStatus(address ? "connected" : "anonymous");
    setAuthFlag(!!address);
  }, []);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    const wants = hasAuthFlag() || AUTH_PATH.test(window.location.pathname);
    if (!wants) {
      // Nothing to restore: settle as anonymous without touching the SDK (next tick, after hydration).
      queueMicrotask(() => {
        if (!cancelled) setStatus("anonymous");
      });
      return () => {
        cancelled = true;
      };
    }
    loadSdk()
      .then(async (s) => {
        if (cancelled) return;
        setSdk(s);
        if (!s.magic) {
          setStatus("anonymous");
          return;
        }
        const ok = await s.magic.user.isLoggedIn();
        if (cancelled) return;
        if (ok) await hydrateUser(s);
        else {
          setAuthFlag(false);
          setStatus("anonymous");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [isDemo, hydrateUser]);

  // Signer + viem client over Magic's RPC provider (same user key, two faces)
  const clients = useMemo(() => {
    if (!sdk?.magic) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc = sdk.magic.rpcProvider as any;
    return {
      walletClient: createWalletClient({ chain: polygon, transport: custom(rpc) }),
      ethersSigner: new sdk.ethers.providers.Web3Provider(rpc).getSigner(),
    };
  }, [sdk]);

  // The login page calls this on mount: the SDK downloads while the user types, and a browser that
  // still holds a Magic session (a login from before the flag existed) is recognised without an OTP.
  const warmUp = useCallback(async () => {
    if (isDemo) return;
    const s = await ensureSdk();
    if (!s.magic) return;
    if (await s.magic.user.isLoggedIn()) await hydrateUser(s);
  }, [isDemo, ensureSdk, hydrateUser]);

  const loginWithEmail = useCallback(
    async (address: string) => {
      const s = await ensureSdk();
      if (!s.magic) throw new Error("Magic no está configurado");
      await s.magic.auth.loginWithEmailOTP({ email: address });
      await hydrateUser(s);
    },
    [ensureSdk, hydrateUser],
  );

  const loginWithGoogle = useCallback(async () => {
    const s = await ensureSdk();
    if (!s.magic) throw new Error("Magic no está configurado");
    setAuthFlag(true); // the callback page (same tab) finishes the login and reloads with the flag set
    await s.magic.oauth2.loginWithRedirect({
      provider: "google",
      redirectURI: `${window.location.origin}/oauth/callback`,
    });
  }, [ensureSdk]);

  const logout = useCallback(async () => {
    if (sdk?.magic) await sdk.magic.user.logout().catch(() => undefined);
    setAuthFlag(false);
    setEoaAddress(undefined);
    setEmail(null);
    setStatus("anonymous");
  }, [sdk]);

  const value = useMemo<WalletContextType>(
    () => ({
      status,
      eoaAddress,
      email,
      walletClient: clients?.walletClient ?? null,
      ethersSigner: clients?.ethersSigner ?? null,
      publicClient,
      sdk,
      warmUp,
      loginWithEmail,
      loginWithGoogle,
      logout,
      isDemo,
    }),
    [status, eoaAddress, email, clients, sdk, warmUp, loginWithEmail, loginWithGoogle, logout, isDemo],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
