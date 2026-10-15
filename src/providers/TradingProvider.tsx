"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ClobClient } from "@polymarket/clob-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTransactionState } from "@polymarket/builder-relayer-client";
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { useWallet } from "./WalletContext";
import { CLOB_API_URL, POLYGON_CHAIN_ID, RELAYER_URL, REMOTE_SIGNING_URL } from "@/lib/polymarket/constants";
import { buildApprovalTxs, checkAllApprovals } from "@/lib/polymarket/approvals";
import {
  clearSession,
  loadSession,
  saveSession,
  type ApiCreds,
  type SessionStep,
  type TradingSession,
} from "@/lib/polymarket/session";

/**
 * One-time (per user) setup required to trade on Polymarket through Patoli:
 *   1. derive the user's Safe address from their embedded-wallet EOA
 *   2. deploy the Safe gaslessly through Polymarket's relayer (builder-sponsored)
 *   3. derive/create the user's CLOB API credentials (signature, no server)
 *   4. set token approvals in one batched, gasless Safe transaction
 * After that an authenticated ClobClient with our builder attribution is
 * available to place orders. Mirrors Polymarket's reference implementation.
 */

interface TradingContextType {
  session: TradingSession | null;
  step: SessionStep;
  error: Error | null;
  isReady: boolean;
  safeAddress: `0x${string}` | undefined;
  clobClient: ClobClient | null;
  relayClient: RelayClient | null;
  setupTrading: () => Promise<void>;
  resetTrading: () => void;
}

const TradingContext = createContext<TradingContextType | null>(null);

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used inside TradingProvider");
  return ctx;
}

const builderConfig = () => new BuilderConfig({ remoteBuilderConfig: { url: REMOTE_SIGNING_URL() } });

export function TradingProvider({ children }: { children: ReactNode }) {
  const { eoaAddress, ethersSigner, publicClient } = useWallet();
  // `override` holds a session written during this page life (setup/reset);
  // otherwise we read the persisted one. No effects needed.
  const [override, setOverride] = useState<{ eoa: string; session: TradingSession | null } | null>(null);
  const [step, setStep] = useState<SessionStep>("idle");
  const [error, setError] = useState<Error | null>(null);

  const stored = useMemo(() => (eoaAddress ? loadSession(eoaAddress) : null), [eoaAddress]);
  const session = eoaAddress && override?.eoa === eoaAddress ? override.session : stored;

  const safeAddress = useMemo(() => {
    if (!eoaAddress) return undefined;
    try {
      const cfg = getContractConfig(POLYGON_CHAIN_ID);
      return deriveSafe(eoaAddress, cfg.SafeContracts.SafeFactory) as `0x${string}`;
    } catch {
      return undefined;
    }
  }, [eoaAddress]);

  // Pure constructor: safe to derive. The relayer client bundles its own copy of
  // builder-signing-sdk; runtime shape is identical, only private types differ.
  const relayClient = useMemo(() => {
    if (!ethersSigner) return null;
    return new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      ethersSigner,
      builderConfig() as unknown as ConstructorParameters<typeof RelayClient>[3],
    );
  }, [ethersSigner]);

  const storedCreds = session?.apiCredentials;

  const setupTrading = useCallback(async () => {
    if (!eoaAddress || !ethersSigner || !safeAddress || !publicClient || !relayClient) {
      throw new Error("Primero inicia sesión");
    }
    setError(null);
    setStep("checking");
    try {
      // 1–2. Safe
      let deployed = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deployed = await (relayClient as any).getDeployed(safeAddress);
      } catch {
        const code = await publicClient.getCode({ address: safeAddress });
        deployed = !!code && code !== "0x";
      }
      if (!deployed) {
        setStep("deploying");
        const resp = await relayClient.deploy();
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

      // 3. API credentials
      let creds: ApiCreds | undefined = storedCreds;
      if (!creds?.key || !creds?.secret || !creds?.passphrase) {
        setStep("credentials");
        const temp = new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID, ethersSigner);
        const derived = await temp.deriveApiKey().catch(() => null);
        creds = derived?.key ? derived : await temp.createApiKey();
      }

      // 4. Approvals
      setStep("approvals");
      let approved = await checkAllApprovals(safeAddress);
      if (!approved) {
        const resp = await relayClient.execute(buildApprovalTxs(), "Patoli: permisos de trading");
        await resp.wait();
        approved = true;
      }

      const next: TradingSession = {
        eoaAddress,
        safeAddress,
        isSafeDeployed: true,
        hasApprovals: approved,
        apiCredentials: creds,
        updatedAt: Date.now(),
      };
      saveSession(next);
      setOverride({ eoa: eoaAddress, session: next });
      setStep("complete");
    } catch (e) {
      const err = e instanceof Error ? e : new Error("Error desconocido");
      setError(err);
      setStep("idle");
      throw err;
    }
  }, [eoaAddress, ethersSigner, safeAddress, publicClient, relayClient, storedCreds]);

  const resetTrading = useCallback(() => {
    if (eoaAddress) {
      clearSession(eoaAddress);
      setOverride({ eoa: eoaAddress, session: null });
    }
    setStep("idle");
    setError(null);
  }, [eoaAddress]);

  const isReady = !!(session?.isSafeDeployed && session?.hasApprovals && storedCreds);

  const clobClient = useMemo(() => {
    if (!isReady || !ethersSigner || !safeAddress || !storedCreds) return null;
    // signatureType 2 = EOA signing on behalf of a Safe proxy wallet
    return new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID, ethersSigner, storedCreds, 2, safeAddress, undefined, false, builderConfig());
  }, [isReady, ethersSigner, safeAddress, storedCreds]);

  const value = useMemo<TradingContextType>(
    () => ({ session, step, error, isReady, safeAddress, clobClient, relayClient, setupTrading, resetTrading }),
    [session, step, error, isReady, safeAddress, clobClient, relayClient, setupTrading, resetTrading],
  );

  return <TradingContext.Provider value={value}>{children}</TradingContext.Provider>;
}
