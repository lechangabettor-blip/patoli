"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Chain as ClobChain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTransactionState } from "@polymarket/builder-relayer-client";
import { useWallet } from "./WalletContext";
import {
  CLOB_API_URL,
  PATOLI_BUILDER_CODE,
  POLYGON_CHAIN_ID,
  RELAYER_URL,
  REMOTE_SIGNING_URL,
  isBuilderCodeValid,
} from "@/lib/polymarket/constants";
import {
  batchDeadline,
  buildRedeemCalls,
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
 *   4. set the six V2 approvals in one gasless WALLET batch
 * Afterwards a ClobClient (V2 orders, signature type 3, deposit wallet as
 * maker, our builder code embedded) places orders.
 *
 * Two different "builder" mechanisms, easy to confuse:
 *  - Relayer calls authenticate OUR builder API key via HMAC headers signed
 *    server-side at /api/polymarket/sign.
 *  - Order attribution is the 32-byte builder CODE inside each signed order.
 */

interface TradingContextType {
  session: TradingSession | null;
  step: SessionStep;
  error: Error | null;
  isReady: boolean;
  /** Deposit wallet = where the user's money lives and the maker of orders */
  walletAddress: `0x${string}` | undefined;
  clobClient: ClobClient | null;
  relayClient: RelayClient | null;
  setupTrading: () => Promise<void>;
  /** Wrap USDC.e sitting in the deposit wallet into pUSD (gasless). */
  wrapUsdc: (amount: bigint) => Promise<void>;
  /** Re-run the approval batch if any permission is missing (e.g. a newly required spender). Returns true if it had to. */
  ensureApprovals: () => Promise<boolean>;
  /** Native USDC sent by mistake → pUSD (direct wrap if allowed, else via Polymarket's bridge). Returns the path used. */
  rescueNativeUsdc: (amount: bigint) => Promise<"wrap" | "bridge">;
  /** Move USDC.e parked in the v1 Safe into the deposit wallet (gasless). */
  /** Withdraw: pUSD → USDC.e sent to `to` on Polygon (gasless). Returns tx hash if known. */
  withdraw: (to: `0x${string}`, amount: bigint) => Promise<string | undefined>;
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

const builderConfig = () => new BuilderConfig({ remoteBuilderConfig: { url: REMOTE_SIGNING_URL() } });

/** Turn SDK/axios failures into something a player can act on. */
function friendlyError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? {});
  if (/503|remote signer|invalid authorization|401/i.test(raw)) {
    return new Error("Patoli aún no está conectado a Polymarket (faltan las credenciales de builder). Pronto.");
  }
  if (/user denied|rejected|closed-by-user/i.test(raw)) return new Error("Cancelaste la firma.");
  if (/network|timeout|fetch/i.test(raw)) return new Error("Sin conexión con Polygon. Intenta de nuevo.");
  return e instanceof Error ? e : new Error("Algo falló. Intenta de nuevo.");
}

export function TradingProvider({ children }: { children: ReactNode }) {
  const { eoaAddress, ethersSigner } = useWallet();
  const [override, setOverride] = useState<{ eoa: string; session: TradingSession | null } | null>(null);
  const [step, setStep] = useState<SessionStep>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [derivedWallet, setDerivedWallet] = useState<{ eoa: string; address: `0x${string}` } | null>(null);

  const stored = useMemo(() => (eoaAddress ? loadSession(eoaAddress) : null), [eoaAddress]);
  const session = eoaAddress && override?.eoa === eoaAddress ? override.session : stored;

  // Pure constructor: safe to derive. The relayer client bundles its own copy of
  // builder-signing-sdk; runtime shape is identical, only private types differ.
  const relayClient = useMemo(() => {
    if (!ethersSigner) return null;
    return new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      ethersSigner,
      builderConfig() as unknown as ConstructorParameters<typeof RelayClient>[3],
      undefined,
      { chain: polygonChain },
    );
  }, [ethersSigner]);

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
    if (!eoaAddress || !ethersSigner || !relayClient) throw new Error("Primero inicia sesión");
    setError(null);
    setStep("checking");
    try {
      // 1. Deposit wallet address
      const wallet = (await relayClient.deriveDepositWalletAddress()) as `0x${string}`;

      // 2. Deploy if needed (relayer, builder-sponsored)
      if (!(await isDeployed(wallet))) {
        setStep("deploying");
        const resp = await relayClient.deployDepositWallet();
        const result = await relayClient.pollUntilState(
          resp.transactionID,
          [RelayerTransactionState.STATE_MINED, RelayerTransactionState.STATE_CONFIRMED, RelayerTransactionState.STATE_FAILED],
          "60",
          3000,
        );
        if (!result || result.state === RelayerTransactionState.STATE_FAILED) {
          throw new Error("No se pudo crear tu bóveda. Intenta de nuevo.");
        }
      }

      // 3. API credentials (L1 signature by the EOA; stored locally only)
      let creds: ApiCreds | undefined = storedCreds;
      if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        setStep("credentials");
        const temp = new ClobClient({ host: CLOB_API_URL, chain: ClobChain.POLYGON, signer: ethersSigner });
        creds = await temp.createOrDeriveApiKey();
      }

      // 4. Approvals (one signed WALLET batch, gasless)
      setStep("approvals");
      let approved = await checkV2Approvals(wallet);
      if (!approved) {
        const resp = await relayClient.executeDepositWalletBatch(buildV2ApprovalCalls(), wallet, batchDeadline());
        await resp.wait();
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
      setStep("complete");
    } catch (e) {
      const err = friendlyError(e);
      setError(err);
      setStep("idle");
      throw err;
    }
  }, [eoaAddress, ethersSigner, relayClient, storedCreds]);

  const ensureApprovals = useCallback(async () => {
    if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
    if (await checkV2Approvals(walletAddress)) return false;
    const resp = await relayClient.executeDepositWalletBatch(buildV2ApprovalCalls(), walletAddress, batchDeadline());
    await resp.wait();
    return true;
  }, [relayClient, walletAddress]);

  const wrapUsdc = useCallback(
    async (amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      const resp = await relayClient.executeDepositWalletBatch(buildWrapCalls(walletAddress, amount), walletAddress, batchDeadline());
      await resp.wait();
    },
    [relayClient, walletAddress],
  );

  const rescueNativeUsdc = useCallback(
    async (amount: bigint): Promise<"wrap" | "bridge"> => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (amount <= 0n) throw new Error("Nada que convertir");
      if (!(await isWrapPaused(USDC_NATIVE_ADDRESS))) {
        const resp = await relayClient.executeDepositWalletBatch(buildWrapCalls(walletAddress, amount, USDC_NATIVE_ADDRESS), walletAddress, batchDeadline());
        await resp.wait();
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
      await resp.wait();
      return "bridge";
    },
    [relayClient, walletAddress],
  );

  const withdraw = useCallback(
    async (to: `0x${string}`, amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (amount <= 0n) throw new Error("Monto inválido");
      const resp = await relayClient.executeDepositWalletBatch(buildUnwrapCalls(to, amount), walletAddress, batchDeadline());
      const result = await resp.wait();
      return (result as { transactionHash?: string } | undefined)?.transactionHash;
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
      await resp.wait();
    },
    [relayClient, walletAddress, eoaAddress],
  );

  const redeem = useCallback(
    async (targets: RedeemTarget[]) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      if (targets.length === 0) return undefined;
      const calls = await buildRedeemCalls(walletAddress, targets);
      const resp = await relayClient.executeDepositWalletBatch(calls, walletAddress, batchDeadline());
      const result = await resp.wait();
      return (result as { transactionHash?: string } | undefined)?.transactionHash;
    },
    [relayClient, walletAddress],
  );

  const resetTrading = useCallback(() => {
    if (eoaAddress) {
      clearSession(eoaAddress);
      setOverride({ eoa: eoaAddress, session: null });
    }
    setStep("idle");
    setError(null);
  }, [eoaAddress]);

  const fundingWallet = session?.walletAddress;
  const isReady = !!(session?.version === SESSION_VERSION && session.isDeployed && session.hasApprovals && storedCreds && fundingWallet);

  const clobClient = useMemo(() => {
    if (!isReady || !ethersSigner || !fundingWallet || !storedCreds) return null;
    return new ClobClient({
      host: CLOB_API_URL,
      chain: ClobChain.POLYGON,
      signer: ethersSigner,
      creds: storedCreds,
      // Deposit wallet: the wallet is the maker, the EOA signs (EIP-1271 flow)
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: fundingWallet,
      builderConfig: isBuilderCodeValid(PATOLI_BUILDER_CODE) ? { builderCode: PATOLI_BUILDER_CODE } : undefined,
      useServerTime: true,
    });
  }, [isReady, ethersSigner, fundingWallet, storedCreds]);

  const value = useMemo<TradingContextType>(
    () => ({
      session,
      step,
      error,
      isReady,
      walletAddress,
      clobClient,
      relayClient,
      setupTrading,
      wrapUsdc,
      ensureApprovals,
      rescueNativeUsdc,
      withdraw,
      depositArena,
      redeem,
      resetTrading,
    }),
    [session, step, error, isReady, walletAddress, clobClient, relayClient, setupTrading, wrapUsdc, ensureApprovals, rescueNativeUsdc, withdraw, depositArena, redeem, resetTrading],
  );

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}
