"use client";

import { createContext, useContext } from "react";
import type { PublicClient, WalletClient } from "viem";
import type { providers } from "ethers";
import type { Sdk } from "@/lib/sdk";

export type AuthStatus = "loading" | "anonymous" | "connected";

export interface WalletContextType {
  status: AuthStatus;
  /** Embedded wallet EOA (signs everything) */
  eoaAddress: `0x${string}` | undefined;
  /** Login identity (email) when available */
  email: string | null;
  walletClient: WalletClient | null;
  ethersSigner: providers.JsonRpcSigner | null;
  publicClient: PublicClient | null;
  /** The lazily loaded wallet SDKs (Magic, ethers, Polymarket clients); null until someone logs in */
  sdk: Sdk | null;
  /** Load the SDK now and restore a Magic session if one exists (the login page calls it on mount). */
  warmUp: () => Promise<void>;
  loginWithEmail: (email: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  /** True when NEXT_PUBLIC_MAGIC_API_KEY is missing (dev/demo mode) */
  isDemo: boolean;
}

export const WalletContext = createContext<WalletContextType>({
  status: "loading",
  eoaAddress: undefined,
  email: null,
  walletClient: null,
  ethersSigner: null,
  publicClient: null,
  sdk: null,
  warmUp: async () => {},
  loginWithEmail: async () => {},
  loginWithGoogle: async () => {},
  logout: async () => {},
  isDemo: true,
});

export const useWallet = () => useContext(WalletContext);
