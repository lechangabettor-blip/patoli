"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Chain as ClobChain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTransactionState } from "@polymarket/builder-relayer-client";
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { encodeFunctionData, erc20Abi } from "viem";
import { useWallet } from "./WalletContext";
import {
  CLOB_API_URL,
  PATOLI_BUILDER_CODE,
  POLYGON_CHAIN_ID,
  RELAYER_URL,
  REMOTE_SIGNING_URL,
  USDC_E_ADDRESS,
  isBuilderCodeValid,
} from "@/lib/polymarket/constants";
import {
  batchDeadline,
  buildV2ApprovalCalls,
  buildWrapCalls,
  checkV2Approvals,
  erc20Balance,
  isDeployed,
  polygonChain,
} from "@/lib/polymarket/v2";
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
  legacySafeAddress: `0x${string}` | undefined;
  clobClient: ClobClient | null;
  relayClient: RelayClient | null;
  setupTrading: () => Promise<void>;
  /** Wrap USDC.e sitting in the deposit wallet into pUSD (gasless). */
  wrapUsdc: (amount: bigint) => Promise<void>;
  /** Move USDC.e parked in the v1 Safe into the deposit wallet (gasless). */
  migrateFromSafe: (amount: bigint) => Promise<void>;
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

  const legacySafeAddress = useMemo<`0x${string}` | undefined>(() => {
    if (session?.legacySafeAddress) return session.legacySafeAddress as `0x${string}`;
    if (!eoaAddress) return undefined;
    try {
      const cfg = getContractConfig(POLYGON_CHAIN_ID);
      return deriveSafe(eoaAddress, cfg.SafeContracts.SafeFactory) as `0x${string}`;
    } catch {
      return undefined;
    }
  }, [eoaAddress, session?.legacySafeAddress]);

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
        legacySafeAddress,
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
  }, [eoaAddress, ethersSigner, relayClient, storedCreds, legacySafeAddress]);

  const wrapUsdc = useCallback(
    async (amount: bigint) => {
      if (!relayClient || !walletAddress) throw new Error("Primero activa tu cuenta");
      const resp = await relayClient.executeDepositWalletBatch(buildWrapCalls(walletAddress, amount), walletAddress, batchDeadline());
      await resp.wait();
    },
    [relayClient, walletAddress],
  );

  const migrateFromSafe = useCallback(
    async (amount: bigint) => {
      if (!relayClient || !walletAddress || !legacySafeAddress) throw new Error("Nada que mover");
      const bal = await erc20Balance(USDC_E_ADDRESS, legacySafeAddress);
      const amt = amount > bal ? bal : amount;
      if (amt <= 0n) return;
      // Safe transaction (v1 relayer path still works for existing Safes)
      const resp = await relayClient.execute(
        [
          {
            to: USDC_E_ADDRESS,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [walletAddress, amt] }),
            value: "0",
          },
        ],
        "Patoli: mover USDC.e a la bóveda nueva",
      );
      await resp.wait();
    },
    [relayClient, walletAddress, legacySafeAddress],
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
      legacySafeAddress,
      clobClient,
      relayClient,
      setupTrading,
      wrapUsdc,
      migrateFromSafe,
      resetTrading,
    }),
    [session, step, error, isReady, walletAddress, legacySafeAddress, clobClient, relayClient, setupTrading, wrapUsdc, migrateFromSafe, resetTrading],
  );

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}
