"use client";

import { polygon } from "viem/chains";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";

/**
 * The wallet stack — Magic, ethers v5 and Polymarket's three clients — is ~2.6 MB of JavaScript
 * that an anonymous reader of the feed never needs. It is loaded here on demand: when the
 * browser remembers a login (the flag below), on the login and OAuth pages, or the moment the
 * user taps a login button. Everything else imports only types from these packages.
 */
async function load() {
  const [{ Magic }, { OAuthExtension }, ethers, clob, relay, signing] = await Promise.all([
    import("magic-sdk"),
    import("@magic-ext/oauth2"),
    import("ethers"),
    import("@polymarket/clob-client-v2"),
    import("@polymarket/builder-relayer-client"),
    import("@polymarket/builder-signing-sdk"),
  ]);
  const key = process.env.NEXT_PUBLIC_MAGIC_API_KEY;
  const magic = key
    ? new Magic(key, {
        network: { rpcUrl: POLYGON_RPC_URL, chainId: polygon.id },
        extensions: [new OAuthExtension()],
        locale: "es",
      })
    : null;
  return { magic, ethers, clob, relay, signing };
}

export type Sdk = Awaited<ReturnType<typeof load>>;
export type PatoliMagic = NonNullable<Sdk["magic"]>;

let pending: Promise<Sdk> | null = null;
let loaded: Sdk | null = null;

/** Load (once) and return the wallet SDKs. Browser only. */
export function loadSdk(): Promise<Sdk> {
  if (typeof window === "undefined") return Promise.reject(new Error("wallet SDK is browser-only"));
  pending ??= load().then(
    (s) => {
      loaded = s;
      return s;
    },
    (e: unknown) => {
      pending = null; // a chunk that failed to download (weak signal, stale deploy) is retried on the next tap
      throw e;
    },
  );
  return pending;
}

export const sdkIfLoaded = (): Sdk | null => loaded;

/** The Magic client once loaded (null before `loadSdk` resolved or when the key is missing). */
export const getMagic = (): PatoliMagic | null => loaded?.magic ?? null;

export const isMagicConfigured = () => !!process.env.NEXT_PUBLIC_MAGIC_API_KEY;

/** "This browser logged in before": tells the app to load the SDK and restore the session on start. */
const AUTH_FLAG = "patoli.auth";

export function hasAuthFlag(): boolean {
  try {
    const flag = localStorage.getItem(AUTH_FLAG);
    if (flag === "1") return true;
    if (flag === "0") return false; // an explicit logout beats the session-key heuristic below
    // Accounts from before the flag existed: an activated trading session (lib/polymarket/session.ts) proves a login.
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith("patoli.session.")) return true;
    return false;
  } catch {
    return false;
  }
}

export function setAuthFlag(on: boolean): void {
  try {
    localStorage.setItem(AUTH_FLAG, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}
