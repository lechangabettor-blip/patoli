"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { polygon } from "viem/chains";
import { providers } from "ethers";
import { getMagic, isMagicConfigured } from "@/lib/magic";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";
import { WalletContext, type AuthStatus, type WalletContextType } from "./WalletContext";

const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });

/**
 * Wraps Magic (email OTP + Google) and exposes an ethers v5 signer, which is
 * what Polymarket's clob-client and relayer client expect, plus a viem
 * wallet client for everything else.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const isDemo = !isMagicConfigured();
  const [status, setStatus] = useState<AuthStatus>(isDemo ? "anonymous" : "loading");
  const [eoaAddress, setEoaAddress] = useState<`0x${string}` | undefined>();
  const [email, setEmail] = useState<string | null>(null);
  // Magic is only constructible in the browser; after mount we re-render with it.
  const [mounted, setMounted] = useState(false);

  const clients = useMemo(() => {
    if (!mounted) return null;
    const magic = getMagic();
    if (!magic) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rpc = magic.rpcProvider as any;
    return {
      walletClient: createWalletClient({ chain: polygon, transport: custom(rpc) }),
      ethersSigner: new providers.Web3Provider(rpc).getSigner(),
    };
  }, [mounted]);

  const hydrateUser = useCallback(async () => {
    const magic = getMagic();
    if (!magic) return;
    const info = await magic.user.getInfo();
    const address = (info.wallets?.ethereum?.publicAddress ?? null) as `0x${string}` | null;
    setEoaAddress(address ?? undefined);
    setEmail(info.email ?? null);
    setStatus(address ? "connected" : "anonymous");
  }, []);

  useEffect(() => {
    const magic = getMagic();
    const frame = requestAnimationFrame(() => setMounted(true));
    if (!magic) return () => cancelAnimationFrame(frame);
    magic.user
      .isLoggedIn()
      .then((ok: boolean) => (ok ? hydrateUser() : setStatus("anonymous")))
      .catch(() => setStatus("anonymous"));
    return () => cancelAnimationFrame(frame);
  }, [hydrateUser]);

  const loginWithEmail = useCallback(
    async (address: string) => {
      const magic = getMagic();
      if (!magic) throw new Error("Magic no está configurado");
      await magic.auth.loginWithEmailOTP({ email: address });
      await hydrateUser();
    },
    [hydrateUser],
  );

  const loginWithGoogle = useCallback(async () => {
    const magic = getMagic();
    if (!magic) throw new Error("Magic no está configurado");
    await magic.oauth2.loginWithRedirect({
      provider: "google",
      redirectURI: `${window.location.origin}/oauth/callback`,
    });
  }, []);

  const logout = useCallback(async () => {
    const magic = getMagic();
    if (magic) await magic.user.logout().catch(() => undefined);
    setEoaAddress(undefined);
    setEmail(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<WalletContextType>(
    () => ({
      status,
      eoaAddress,
      email,
      walletClient: clients?.walletClient ?? null,
      ethersSigner: clients?.ethersSigner ?? null,
      publicClient,
      loginWithEmail,
      loginWithGoogle,
      logout,
      isDemo,
    }),
    [status, eoaAddress, email, clients, loginWithEmail, loginWithGoogle, logout, isDemo],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
