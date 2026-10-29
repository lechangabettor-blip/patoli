"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ClobClient } from "@polymarket/clob-client-v2";
import type { RelayClient } from "@polymarket/builder-relayer-client";
import { useWallet } from "./WalletContext";
import { getMagic, type Sdk } from "@/lib/sdk";
import {
  CLOB_API_URL,
  PATOLI_BUILDER_CODE,
  POLYGON_CHAIN_ID,
  PUSD_ADDRESS,
  PUSD_DECIMALS,
  TIP_MAX_USD,
  RELAYER_URL,
  REMOTE_SIGNING_URL,
  isBuilderCodeValid,
} from "@/lib/polymarket/constants";
import {
  batchDeadline,
  buildRedeemBatches,
  buildUnwrapCalls,
  buildV2ApprovalCalls,
  buildWrapCalls,
  type RedeemTarget,
  checkV2Approvals,
  isDeployed,
  polygonChain,
  isWrapPaused,
  buildErc20TransferCall,
  USDC_NATIVE_ADDRESS,
  buildArenaDepositCalls,
  publicClient,
} from "@/lib/polymarket/v2";
import { ARENA_ADDRESS, ARENA_ROUTER_ADDRESS, isArenaConfigured, isRouterConfigured } from "@/lib/arena/typed-data";
import { arenaAbi, routerAbi } from "@/lib/arena/abi";
import { forgetCollateralSync } from "@/lib/polymarket/clob-cache";
import {
  SESSION_VERSION,
  clearSession,
  loadSession,
  saveSession,
  type ApiCreds,
  type SessionStep,
  type TradingSession,
} from "@/lib/polymarket/session";

/**
 * One-time (per user) setup to trade on Polymarket through Patoli, V2 style:
 *   1. derive the user's deposit wallet from their embedded-wallet EOA
 *   2. deploy it gaslessly through Polymarket's relayer (our builder key signs)
 *   3. derive/create the user's CLOB API credentials (EOA signature, no server)
 *   4. set the V2 approvals in one gasless WALLET batch
 * Afterwards a ClobClient (V2 orders, signature type 3, deposit wallet as
 * maker, our builder code embedded) places orders.
 *
 * Two different "builder" mechanisms, easy to confuse:
 *  - Relayer calls authenticate OUR builder API key via HMAC headers signed
 *    server-side at /api/polymarket/sign.
 *  - Order attribution is the 32-byte builder CODE inside each signed order.
 *
 * The SDK classes come from the lazily loaded bundle (lib/sdk.ts) through WalletContext.
 */

interface TradingContextType {
  session: TradingSession | null;
  step: SessionStep;
  error: Error | null;
  isReady: boolean;
  /** Deposit wallet = where the user's money lives and the maker of orders */
  walletAddress: `0x${string}` | undefined;
  clobClient: ClobClient | null;
  /** The order client at call time — valid right after `setupTrading` resolves, before React re-rendered (first bet in one tap). */
  getClobClient: () => ClobClient | null;
  relayClient: RelayClient | null;
  setupTrading: () => Promise<void>;
  /** Wrap USDC.e sitting in the deposit wallet into pUSD (gasless). */
  wrapUsdc: (amount: bigint) => Promise<void>;
  /** Re-run the approval batch if any permission is missing (e.g. a newly required spender). Returns true if it had to. */
  ensureApprovals: () => Promise<boolean>;
  /** Native USDC sent by mistake → pUSD (direct wrap if allowed, else via Polymarket's bridge). Returns the path used. */
  rescueNativeUsdc: (amount: bigint) => Promise<"wrap" | "bridge">;
  /** Withdraw: pUSD → USDC.e sent to `to` on Polygon (gasless). Returns tx hash if known. */
  withdraw: (to: `0x${string}`, amount: bigint) => Promise<string | undefined>;
  /** Tip: plain pUSD transfer to another user's deposit wallet (gasless; ≤ TIP_MAX_USD). Returns tx hash. */
  tip: (to: `0x${string}`, amount: bigint) => Promise<string | undefined>;
  /** Move pUSD from the deposit wallet into the Arena escrow (gasless batch; credited to the EOA). */
  depositArena: (amount: bigint) => Promise<void>;
  /** Cobrar: redeem resolved positions into pUSD (gasless, one signature for all). */
  redeem: (targets: RedeemTarget[]) => Promise<string | undefined>;
  resetTrading: () => void;
}

const TradingContext = createContext<TradingContextType | null>(null);

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used inside TradingProvider");
  return ctx;
}

type Signer = NonNullable<ReturnType<typeof useWallet>["ethersSigner"]>;
type RelayBuilderConfig = ConstructorParameters<Sdk["relay"]["RelayClient"]>[3];

// /api/polymarket/sign only answers logged-in users: the SDK reads `remoteBuilderConfig.token` on
// every signing request, so a getter hands it the latest Magic DID token (refreshed below).
let signingToken: string | undefined;
const builderConfig = (sdk: Sdk) =>
  new sdk.signing.BuilderConfig({
    remoteBuilderConfig: {
      url: REMOTE_SIGNING_URL(),
      get token() {
        return signingToken;
      },
    },
  });

/** A V2 order client: deposit wallet as maker/funder, the EOA signs (EIP-1271), Patoli's code inside every order. */
function makeClobClient(sdk: Sdk, signer: Signer, funder: `0x${string}`, creds: ApiCreds): ClobClient {
  return new sdk.clob.ClobClient({
    host: CLOB_API_URL,
    chain: sdk.clob.Chain.POLYGON,
    signer,
    creds,
    signatureType: sdk.clob.SignatureTypeV2.POLY_1271,
    funderAddress: funder,
    builderConfig: isBuilderCodeValid(PATOLI_BUILDER_CODE) ? { builderCode: PATOLI_BUILDER_CODE } : undefined,
    useServerTime: true,
  });
}

/**
 * The relayer's `wait()` resolves to undefined both when the batch REVERTED (STATE_FAILED) and when
 * it is still unconfirmed after its polling budget: neither is success, and the one-tap flows
 * (wrap → bet, wrap → tip, auto-cobro) must never continue past a batch that did not land.
 */
async function confirmed(resp: { wait: () => Promise<unknown> }, what: string): Promise<{ transactionHash?: string }> {
  const r = (await resp.wait()) as { transactionHash?: string } | undefined;
  if (!r) throw new Error(`${what} no se confirmó en Polygon. Revisa tu saldo en unos segundos antes de reintentar.`);
  return r;
}

/** Turn SDK/axios failures into something a player can act on. */
function friendlyError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? {});
  if (/503|remote signer|invalid authorization|401/i.test(raw)) {
    return new Error("Patoli aún no está conectado a Polymarket (faltan las credenciales de builder). Pronto.");
  }
  if (/user denied|rejected|closed-by-user/i.test(raw)) return new Error("Cancelaste la firma.");
  // Builder Program daily relayer quota (100/day while Unverified): everything gasless pauses until the next UTC day.
  if (/quota exceeded|429|too many requests/i.test(raw)) return new Error("Polymarket limitó las transacciones gratis de hoy. Intenta más tarde.");
  if (/network|timeout|fetch/i.test(raw)) return new Error("Sin conexión con Polygon. Intenta de nuevo.");
  return e instanceof Error ? e : new Error("Algo falló. Intenta de nuevo.");
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { eoaAddress, ethersSigner, sdk } = useWallet();
  const [override, setOverride] = useState<{ eoa: string; session: TradingSession | null } | null>(null);
  const [step, setStep] = useState<SessionStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [derivedWallet, setDerivedWallet] = useState<{ eoa: string; address: `0x${string}` } | null>(null);
  // Always the latest order client, including the one built inside `setupTrading` before any re-render.
  const clientRef = useRef<ClobClient | null>(null);
  // One wrap batch per (wallet, amount) at a time: AutoSettle, the bet sheet, the tip sheet and the
  // Convertir card can all ask for the same USDC.e within a second of each other.
  const wrapInFlight = useRef<{ key: string; p: Promise<void> } | null>(null);
  // One cobro per wallet at a time: AutoSettle, the Cobrar button and a second tab would otherwise
  // read the same balances and the later batch would revert (Router: amount > balance).
  const redeemInFlight = useRef<{ wallet: string; p: Promise<string | undefined> } | null>(null);

  // Keep a DID token ready for the remote signer while logged in (15-min lifespan, refreshed every 10).
  useEffect(() => {
    if (!eoaAddress) {
      signingToken = undefined;
      return;
    }
    let alive = true;
    const mint = async () => {
      try {
        const t = await getMagic()?.user.getIdToken({ lifespan: 900 });
        if (alive && t) signingToken = t;
      } catch {
        /* next refresh will retry */
      }
    };
    void mint();
    const timer = setInterval(() => void mint(), 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [eoaAddress]);

  const stored = useMemo(() => (eoaAddress ? loadSession(eoaAddress) : null), [eoaAddress]);
  const session = eoaAddress && override?.eoa === eoaAddress ? override.session : stored;

  // Pure constructor: safe to derive. The relayer client bundles its own copy of
  // builder-signing-sdk; runtime shape is identical, only private types differ.
  const relayClient = useMemo(() => {
    if (!ethersSigner || !sdk) return null;
    return new sdk.relay.RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, ethersSigner, builderConfig(sdk) as unknown as RelayBuilderConfig, undefined, { chain: polygonChain });
  }, [ethersSigner, sdk]);

  // Deposit wallet address: async (asks the factory which proxy flavour it mints)
  useEffect(() => {
    if (!relayClient || !eoaAddress) return;
    let cancelled = false;
    relayClient
      .deriveDepositWalletAddress()
      .then((addr) => {
        if (!cancelled) setDerivedWallet({ eoa: eoaAddress, address: addr as `0x${string}` });
      })
      .catch((e) => console.warn("[patoli] deposit wallet derivation failed", e));
    return () => {
      cancelled = true;
    };
  }, [relayClient, eoaAddress]);

  const walletAddress: `0x${string}` | undefined =
    (session?.walletAddress as `0x${string}` | undefined) ||
    (derivedWallet && derivedWallet.eoa === eoaAddress ? derivedWallet.address : undefined);

  const storedCreds = session?.apiCredentials;

  const setupTrading = useCallback(async () => {
    if (!eoaAddress || !ethersSigner || !relayClient || !sdk) throw new Error("Primero inicia sesión");
    setError(null);
    setStep("checking");
    try {
      // 1. Deposit wallet address
      const wallet = (await relayClient.deriveDepositWalletAddress()) as `0x${string}`;

      // 2. Deploy if needed (relayer, builder-sponsored)
      if (!(await isDeployed(wallet))) {
        setStep("deploying");
        const { RelayerTransactionState: S } = sdk.relay;
        const resp = await relayClient.deployDepositWallet();
        const result = await relayClient.pollUntilState(resp.transactionID, [S.STATE_MINED, S.STATE_CONFIRMED, S.STATE_FAILED], "60", 3000);
        if (!result || result.state === S.STATE_FAILED) {
          throw new Error("No se pudo crear tu bóveda. Intenta de nuevo.");
        }
      }

      // 3. API credentials (L1 signature by the EOA; stored locally only)
      let creds: ApiCreds | undefined = storedCreds;
      if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        setStep("credentials");
        const temp = new sdk.clob.ClobClient({ host: CLOB_API_URL, chain: sdk.clob.Chain.POLYGON, signer: ethersSigner });
        creds = await temp.createOrDeriveApiKey();
      }

      // 4. Approvals (one signed WALLET batch, gasless)
      setStep("approvals");
      let approved = await checkV2Approvals(wallet);
      if (!approved) {
        const resp = await relayClient.executeDepositWalletBatch(buildV2ApprovalCalls(), wallet, batchDeadline());
        await confirmed(resp, "El permiso de trading");
        approved = true;
      }

      const next: TradingSession = {
        version: SESSION_VERSION,
        eoaAddress,
        walletAddress: wallet,
        isDeployed: true,
        hasApprovals: approved,
        apiCredentials: creds,
        updatedAt: Date.now(),
      };
      saveSession(next);
      setOverride({ eoa: eoaAddress, session: next });
      // The order the user is placing right now can go out before React re-renders.
      clientRef.current = makeClobClient(sdk, ethersSigner, wallet, creds);
      setStep("complete");
    } catch (e) {
      const err = friendlyError(e);
      setError(err);
      setStep("idle");
      throw err;
    }
  }, [eoaAddress, ethersSigner, relayClient, storedCreds, sdk]);

  const ensureApprovals = useCallback(async () => {
    if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
    if (await checkV2Approvals(walletAddress)) return false;
    const resp = await relayClient.executeDepositWalletBatch(buildV2ApprovalCalls(), walletAddress, batchDeadline());
    await confirmed(resp, "El permiso de trading");
    return true;
  }, [relayClient, walletAddress]);

  const wrapUsdc = useCallback(
    async (amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      const key = `${walletAddress.toLowerCase()}:${amount}`;
      if (wrapInFlight.current?.key === key) return wrapInFlight.current.p; // everyone awaits the same batch
      const p = (async () => {
        const resp = await relayClient.executeDepositWalletBatch(buildWrapCalls(walletAddress, amount), walletAddress, batchDeadline());
        await confirmed(resp, "La conversión a pUSD");
        forgetCollateralSync(); // the CLOB caches balances: the next order re-syncs before sending
      })().finally(() => {
        if (wrapInFlight.current?.p === p) wrapInFlight.current = null;
      });
      wrapInFlight.current = { key, p };
      return p;
    },
    [relayClient, walletAddress],
  );

  const rescueNativeUsdc = useCallback(
    async (amount: bigint): Promise<"wrap" | "bridge"> => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (amount <= 0n) throw new Error("Nada que convertir");
      if (!(await isWrapPaused(USDC_NATIVE_ADDRESS))) {
        const resp = await relayClient.executeDepositWalletBatch(buildWrapCalls(walletAddress, amount, USDC_NATIVE_ADDRESS), walletAddress, batchDeadline());
        await confirmed(resp, "La conversión a pUSD");
        forgetCollateralSync();
        return "wrap";
      }
      // Onramp paused for native USDC → forward to the user's own Polymarket bridge
      // address; the bridge converts to pUSD and credits this same deposit wallet.
      const r = await fetch("/api/polymarket/bridge-address", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletAddress }),
      });
      const j = (await r.json().catch(() => ({}))) as { evm?: string; error?: string };
      if (!r.ok || !j.evm || !/^0x[0-9a-fA-F]{40}$/.test(j.evm)) throw new Error(j.error ?? "No se pudo obtener la dirección del puente");
      const resp = await relayClient.executeDepositWalletBatch(
        [buildErc20TransferCall(USDC_NATIVE_ADDRESS, j.evm as `0x${string}`, amount)],
        walletAddress,
        batchDeadline(),
      );
      await confirmed(resp, "El envío al puente");
      return "bridge";
    },
    [relayClient, walletAddress],
  );

  const withdraw = useCallback(
    async (to: `0x${string}`, amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (amount <= 0n) throw new Error("Monto inválido");
      const resp = await relayClient.executeDepositWalletBatch(buildUnwrapCalls(to, amount), walletAddress, batchDeadline());
      const result = await confirmed(resp, "El retiro");
      forgetCollateralSync();
      return result.transactionHash;
    },
    [relayClient, walletAddress],
  );

  const tip = useCallback(
    async (to: `0x${string}`, amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (amount <= 0n) throw new Error("Monto inválido");
      if (amount > BigInt(TIP_MAX_USD) * 10n ** BigInt(PUSD_DECIMALS)) throw new Error(`El tip máximo es ${TIP_MAX_USD}`);
      if (to.toLowerCase() === walletAddress.toLowerCase()) throw new Error("No te puedes dar tip a ti mismo");
      const resp = await relayClient.executeDepositWalletBatch([buildErc20TransferCall(PUSD_ADDRESS, to, amount)], walletAddress, batchDeadline());
      const result = await confirmed(resp, "El tip");
      forgetCollateralSync();
      return result.transactionHash;
    },
    [relayClient, walletAddress],
  );

  const depositArena = useCallback(
    async (amount: bigint) => {
      if (!relayClient || !walletAddress || !eoaAddress) throw new Error("Primero activa tu cuenta");
      if (!isArenaConfigured() || !isRouterConfigured()) throw new Error("La arena aún no está activa");
      if (amount <= 0n) throw new Error("Monto inválido");
      const paused = await publicClient.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "depositsPaused" });
      if (paused) throw new Error("La arena no acepta depósitos por ahora. Intenta más tarde.");
      const forwarder = await publicClient.readContract({ address: ARENA_ROUTER_ADDRESS, abi: routerAbi, functionName: "forwarderOf", args: [eoaAddress as `0x${string}`] });
      const resp = await relayClient.executeDepositWalletBatch(buildArenaDepositCalls(forwarder, amount), walletAddress, batchDeadline());
      await confirmed(resp, "El depósito a la arena");
      forgetCollateralSync();
    },
    [relayClient, walletAddress, eoaAddress],
  );

  const redeem = useCallback(
    async (targets: RedeemTarget[]) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (targets.length === 0) return undefined;
      // One relayer batch per protocol (CTF adapters first, then the Protocol V2 Router): a batch is
      // atomic, so a revert on one side must never hold the other side's winnings. Nothing to send
      // (every V2 position already emptied) = no signature, no relayer transaction.
      if (redeemInFlight.current?.wallet === walletAddress) return redeemInFlight.current.p;
      const p = (async () => {
        const batches = await buildRedeemBatches(walletAddress, targets);
        let hash: string | undefined;
        let failure: unknown;
        try {
          for (const calls of batches) {
            try {
              const resp = await relayClient.executeDepositWalletBatch(calls, walletAddress, batchDeadline());
              hash = (await confirmed(resp, "El cobro")).transactionHash ?? hash;
            } catch (e) {
              failure ??= e; // the other protocol's batch is independent: keep going, report after
            }
          }
        } finally {
          if (hash) forgetCollateralSync();
        }
        if (failure) throw failure;
        return hash;
      })();
      redeemInFlight.current = { wallet: walletAddress, p };
      try {
        return await p;
      } finally {
        redeemInFlight.current = null;
      }
    },
    [relayClient, walletAddress],
  );

  const resetTrading = useCallback(() => {
    if (eoaAddress) {
      clearSession(eoaAddress);
      setOverride({ eoa: eoaAddress, session: null });
    }
    clientRef.current = null;
    setStep("idle");
    setError(null);
  }, [eoaAddress]);

  const fundingWallet = session?.walletAddress as `0x${string}` | undefined;
  const isReady = !!(session?.version === SESSION_VERSION && session.isDeployed && session.hasApprovals && storedCreds && fundingWallet);

  const clobClient = useMemo(() => {
    if (!isReady || !ethersSigner || !fundingWallet || !storedCreds || !sdk) return null;
    return makeClobClient(sdk, ethersSigner, fundingWallet, storedCreds);
  }, [isReady, ethersSigner, fundingWallet, storedCreds, sdk]);

  useEffect(() => {
    clientRef.current = clobClient;
  }, [clobClient]);
  const getClobClient = useCallback(() => clientRef.current, []);

  const value = useMemo<TradingContextType>(
    () => ({
      session,
      step,
      error,
      isReady,
      walletAddress,
      clobClient,
      getClobClient,
      relayClient,
      setupTrading,
      wrapUsdc,
      ensureApprovals,
      rescueNativeUsdc,
      withdraw,
      tip,
      depositArena,
      redeem,
      resetTrading,
    }),
    [session, step, error, isReady, walletAddress, clobClient, getClobClient, relayClient, setupTrading, wrapUsdc, ensureApprovals, rescueNativeUsdc, withdraw, tip, depositArena, redeem, resetTrading],
  );

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}
