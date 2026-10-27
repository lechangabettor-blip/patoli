"use client";

import { Magic } from "magic-sdk";
import { OAuthExtension } from "@magic-ext/oauth2";
import { polygon } from "viem/chains";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";

function createMagic(key: string) {
  return new Magic(key, {
    network: { rpcUrl: POLYGON_RPC_URL, chainId: polygon.id },
    extensions: [new OAuthExtension()],
    locale: "es",
  });
}

type PatoliMagic = ReturnType<typeof createMagic>;

let instance: PatoliMagic | null = null;

/** Singleton Magic client (email OTP + Google OAuth), Polygon network. */
export function getMagic(): PatoliMagic | null {
  if (typeof window === "undefined") return null;
  const key = process.env.NEXT_PUBLIC_MAGIC_API_KEY;
  if (!key) return null;
  if (!instance) instance = createMagic(key);
  return instance;
}

export const isMagicConfigured = () => !!process.env.NEXT_PUBLIC_MAGIC_API_KEY;
