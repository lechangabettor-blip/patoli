import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, type Chain } from "viem";
import { polygon } from "viem/chains";
import type { DepositWalletCall } from "@polymarket/builder-relayer-client";
import type { Position } from "./public-api";
import { v2ConditionBytes31, v2OutcomeIndex } from "./protocol";
import {
  COLLATERAL_OFFRAMP_ADDRESS,
  COLLATERAL_ONRAMP_ADDRESS,
  CTF_ADDRESS,
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  V2_ROUTER_ADDRESS,
  POLYGON_RPC_URL,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
  USDC_NATIVE_ADDRESS,
  V2_NEG_RISK_EXCHANGE_ADDRESS,
  V2_POSITION_MANAGER_ADDRESS,
  V2_PROTOCOL_EXCHANGE_ADDRESS,
  V2_STANDARD_EXCHANGE_ADDRESS,
} from "./constants";

/**
 * CLOB V2 / deposit-wallet plumbing.
 *
 * A deposit wallet is Polymarket's smart wallet (since May 2026). It is owned by
 * the user's EOA, deployed gaslessly by Polymarket's relayer (authenticated with
 * OUR builder API key), and it executes "WALLET" batches that the owner signs
 * (EIP-712, domain "DepositWallet"). Collateral is pUSD = USDC.e wrapped 1:1
 * through the CollateralOnramp. Orders use signature type 3 (POLY_1271) with the
 * deposit wallet as maker and the EOA as signer.
 */

/** viem chain with OUR rpc (viem's default Polygon RPC is dead/401). */
export const polygonChain: Chain = {
  ...polygon,
  rpcUrls: { default: { http: [POLYGON_RPC_URL] } },
};

export const publicClient = createPublicClient({ chain: polygonChain, transport: http(POLYGON_RPC_URL) });

const MAX_UINT256 = (1n << 256n) - 1n;

const erc1155Abi = parseAbi([
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
]);

const onrampAbi = parseAbi(["function wrap(address _asset, address _to, uint256 _amount)", "function paused(address) view returns (bool)"]);
const offrampAbi = parseAbi(["function unwrap(address _asset, address _to, uint256 _amount)"]);

// pUSD spenders (ERC-20 approve)
// Neg-risk markets (multi-outcome events, e.g. soccer 1X2) also spend through the
// NegRiskAdapter — the CLOB checks ITS allowance ("spender 0xd91E… allowance: 0").
const PUSD_SPENDERS = [V2_PROTOCOL_EXCHANGE_ADDRESS, V2_STANDARD_EXCHANGE_ADDRESS, V2_NEG_RISK_EXCHANGE_ADDRESS, NEG_RISK_ADAPTER_ADDRESS] as const;
// Conditional tokens operators (ERC-1155 setApprovalForAll): the exchanges
// (trading) and the collateral adapters (redeeming winnings).
const CTF_OPERATORS = [V2_STANDARD_EXCHANGE_ADDRESS, V2_NEG_RISK_EXCHANGE_ADDRESS, NEG_RISK_ADAPTER_ADDRESS, CTF_COLLATERAL_ADAPTER_ADDRESS, NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS] as const;
// PositionManager operators: the Protocol V2 exchange (trading) and the Router (redeeming)
const PM_OPERATORS = [V2_PROTOCOL_EXCHANGE_ADDRESS, V2_ROUTER_ADDRESS] as const;

const ctfAdapterAbi = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

export type RedeemTarget =
  | { kind: "ctf"; conditionId: `0x${string}`; negRisk: boolean }
  | { kind: "v2"; conditionId: `0x${string}`; positionId: string; outcomeIndex: number };

/**
 * Redeem targets from Data API positions. CTF: one per market (the adapter redeems both outcomes
 * in one call). Protocol V2: one per held position (the Router redeems one outcome per call); the
 * outcome index comes from the position id itself, so the pair can never disagree on-chain.
 */
export function redeemTargetsFrom(positions: Position[]): RedeemTarget[] {
  const out: RedeemTarget[] = [];
  const seen = new Set<string>();
  for (const p of positions) {
    const conditionId = p.conditionId.toLowerCase() as `0x${string}`;
    const key = p.v2 ? `v2:${p.asset}` : `ctf:${conditionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.v2 ? { kind: "v2", conditionId, positionId: p.asset, outcomeIndex: v2OutcomeIndex(p.asset) } : { kind: "ctf", conditionId, negRisk: !!p.negativeRisk });
  }
  return out;
}

type CtfTarget = Extract<RedeemTarget, { kind: "ctf" }>;
type V2Target = Extract<RedeemTarget, { kind: "v2" }>;

/** Polygon could not be read: not a failed redemption (AutoSettle does not count it as one). */
export const RPC_READ_ERROR = "RpcReadError";
const rpcReadError = () => Object.assign(new Error("No pudimos leer tus posiciones en Polygon. Intenta de nuevo."), { name: RPC_READ_ERROR });

const routerAbi = parseAbi(["function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)"]);
const positionManagerReadAbi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function getPayout(uint256 positionId, uint256 amount) view returns (uint256)",
]);

/**
 * Gasless redemption as one relayer batch PER PROTOCOL (a batch is atomic: a revert on one side
 * must never hold the other side's winnings). Order: CTF adapters, then the Protocol V2 Router.
 * Batches that would carry no call are omitted.
 */
export async function buildRedeemBatches(wallet: `0x${string}`, targets: RedeemTarget[]): Promise<DepositWalletCall[][]> {
  const ctf = targets.filter((t): t is CtfTarget => t.kind === "ctf");
  const v2 = targets.filter((t): t is V2Target => t.kind === "v2");
  const batches: DepositWalletCall[][] = [];
  if (ctf.length) batches.push(await buildCtfRedeemCalls(wallet, ctf));
  if (v2.length) {
    const calls = await buildV2RedeemCalls(wallet, v2);
    if (calls.length) batches.push(calls);
  }
  return batches;
}

/**
 * Redeem resolved Protocol V2 positions → pUSD through the Router:
 * `redeem(bytes31 conditionId, outcomeIndex, amount)`, one call per held position, the amount read
 * from PositionManager right now (never the Data API's rounded size: the Router reverts on
 * amount > balance). Positions already emptied produce no call. The Router needs the wallet's
 * PositionManager operator approval (granted at activation; re-granted here when missing).
 */
async function buildV2RedeemCalls(wallet: `0x${string}`, targets: V2Target[]): Promise<DepositWalletCall[]> {
  // Value and readiness are decided on-chain, not by the Data API's mark: `getPayout(positionId,
  // balance)` is exactly what the Router would mint. It reverts while the condition is unresolved
  // and returns 0 for a loser — either would make the atomic batch fail or waste a relayer
  // transaction, so such positions are left out until they are worth a call.
  const balanceCalls = targets.map((t) => ({ address: V2_POSITION_MANAGER_ADDRESS, abi: positionManagerReadAbi, functionName: "balanceOf" as const, args: [wallet, BigInt(t.positionId)] as const }));
  // `balanceOf` cannot revert, so a failed balance leg (or a transport error) means Polygon could not
  // be read: say so rather than pretend nothing is held. `getPayout` legs may revert (unresolved).
  const balances = await publicClient.multicall({ contracts: balanceCalls, allowFailure: true }).catch(() => null);
  if (!balances || balances.some((b) => b.status !== "success")) throw rpcReadError();
  const candidates = targets.map((t, i) => ({ t, amount: balances[i].result as bigint })).filter((x) => x.amount > 0n);
  if (candidates.length === 0) return [];
  const payoutCalls = candidates.map(({ t, amount }) => ({ address: V2_POSITION_MANAGER_ADDRESS, abi: positionManagerReadAbi, functionName: "getPayout" as const, args: [BigInt(t.positionId), amount] as const }));
  const payouts = await publicClient.multicall({ contracts: payoutCalls, allowFailure: true }).catch(() => null);
  if (!payouts) throw rpcReadError();
  const held = candidates.filter((_, i) => payouts[i].status === "success" && (payouts[i].result as bigint) > 0n);
  if (held.length === 0) return [];
  const redeems: DepositWalletCall[] = [];
  for (const { t, amount } of held) {
    try {
      redeems.push({
        target: V2_ROUTER_ADDRESS,
        value: "0",
        data: encodeFunctionData({ abi: routerAbi, functionName: "redeem", args: [v2ConditionBytes31(t.conditionId), BigInt(t.outcomeIndex), amount] }),
      });
    } catch (e) {
      console.warn("[patoli] V2 redeem target skipped", t.conditionId, e); // a malformed row must not block the others
    }
  }
  if (redeems.length === 0) return [];
  const approved = await publicClient
    .readContract({ address: V2_POSITION_MANAGER_ADDRESS, abi: erc1155Abi, functionName: "isApprovedForAll", args: [wallet, V2_ROUTER_ADDRESS] })
    .catch(() => false);
  const approval: DepositWalletCall[] = approved
    ? []
    : [{ target: V2_POSITION_MANAGER_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [V2_ROUTER_ADDRESS, true] }) }];
  return [...approval, ...redeems];
}

/**
 * Redeem resolved CTF positions → pUSD. One call per market; the adapter
 * redeems whatever the wallet holds of both outcomes. Includes the operator
 * approval for the adapter when the wallet hasn't granted it yet.
 */
async function buildCtfRedeemCalls(wallet: `0x${string}`, targets: CtfTarget[]): Promise<DepositWalletCall[]> {
  const calls: DepositWalletCall[] = [];
  const adapters = new Set(targets.map((t) => (t.negRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS : CTF_COLLATERAL_ADAPTER_ADDRESS)));
  for (const adapter of adapters) {
    const ok = await publicClient
      .readContract({ address: CTF_ADDRESS, abi: erc1155Abi, functionName: "isApprovedForAll", args: [wallet, adapter] })
      .catch(() => false);
    if (!ok) {
      calls.push({ target: CTF_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [adapter, true] }) });
    }
  }
  const zero = `0x${"0".repeat(64)}` as `0x${string}`;
  for (const t of targets) {
    const adapter = t.negRisk ? NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS : CTF_COLLATERAL_ADAPTER_ADDRESS;
    calls.push({
      target: adapter,
      value: "0",
      data: encodeFunctionData({ abi: ctfAdapterAbi, functionName: "redeemPositions", args: [PUSD_ADDRESS, zero, t.conditionId, [1n, 2n]] }),
    });
  }
  return calls;
}

export async function checkV2Approvals(wallet: `0x${string}`): Promise<boolean> {
  const threshold = 1_000_000_000_000n; // 1M pUSD
  const [pusd, ctf, pm] = await Promise.all([
    Promise.all(
      PUSD_SPENDERS.map((s) =>
        publicClient
          .readContract({ address: PUSD_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [wallet, s] })
          .then((a) => a >= threshold)
          .catch(() => false),
      ),
    ),
    Promise.all(
      CTF_OPERATORS.map((o) =>
        publicClient
          .readContract({ address: CTF_ADDRESS, abi: erc1155Abi, functionName: "isApprovedForAll", args: [wallet, o] })
          .catch(() => false),
      ),
    ),
    Promise.all(
      PM_OPERATORS.map((o) =>
        publicClient
          .readContract({ address: V2_POSITION_MANAGER_ADDRESS, abi: erc1155Abi, functionName: "isApprovedForAll", args: [wallet, o] })
          .catch(() => false),
      ),
    ),
  ]);
  return [...pusd, ...ctf, ...pm].every(Boolean);
}

/** All six trading approvals, as one gasless WALLET batch. */
export function buildV2ApprovalCalls(): DepositWalletCall[] {
  const calls: DepositWalletCall[] = [];
  for (const s of PUSD_SPENDERS) {
    calls.push({ target: PUSD_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s, MAX_UINT256] }) });
  }
  for (const o of CTF_OPERATORS) {
    calls.push({ target: CTF_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [o, true] }) });
  }
  for (const o of PM_OPERATORS) {
    calls.push({ target: V2_POSITION_MANAGER_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [o, true] }) });
  }
  return calls;
}

/** USDC.e sitting in the deposit wallet → pUSD in the same wallet (approve onramp + wrap). */
export function buildWrapCalls(wallet: `0x${string}`, amount: bigint, asset: `0x${string}` = USDC_E_ADDRESS): DepositWalletCall[] {
  return [
    { target: asset, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COLLATERAL_ONRAMP_ADDRESS, amount] }) },
    { target: COLLATERAL_ONRAMP_ADDRESS, value: "0", data: encodeFunctionData({ abi: onrampAbi, functionName: "wrap", args: [asset, wallet, amount] }) },
  ];
}

/** The Onramp can pause an asset (native USDC is paused as of 2026-10-16). */
export async function isWrapPaused(asset: `0x${string}`): Promise<boolean> {
  try {
    return await publicClient.readContract({ address: COLLATERAL_ONRAMP_ADDRESS, abi: onrampAbi, functionName: "paused", args: [asset] });
  } catch {
    return true; // if we can't tell, take the safe route (bridge)
  }
}

export { USDC_NATIVE_ADDRESS };

/**
 * Withdraw: pUSD in the deposit wallet → USDC.e delivered to `to` (any Polygon
 * address). The offramp's `_to` parameter means no second transfer is needed.
 */
export function buildUnwrapCalls(to: `0x${string}`, amount: bigint): DepositWalletCall[] {
  return [
    { target: PUSD_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COLLATERAL_OFFRAMP_ADDRESS, amount] }) },
    { target: COLLATERAL_OFFRAMP_ADDRESS, value: "0", data: encodeFunctionData({ abi: offrampAbi, functionName: "unwrap", args: [USDC_E_ADDRESS, to, amount] }) },
  ];
}

/**
 * Fund the Arena from the deposit wallet. Polymarket's relayer blocks `approve` to spenders
 * outside its allowlist (verified 2026-10-19: "approve spender … is not in the allowed
 * list"), so we never approve: the wallet does a plain pUSD `transfer` to the user's own
 * forwarder address, and Patoli's operator then calls `ArenaDepositRouter.sweep(user)`,
 * which credits the Arena balance of that user (attribution by CREATE2 address math).
 */
export function buildArenaDepositCalls(forwarder: `0x${string}`, amount: bigint): DepositWalletCall[] {
  return [{ target: PUSD_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [forwarder, amount] }) }];
}

/** Send an ERC-20 out of the deposit wallet (withdrawals, moving funds). */
export function buildErc20TransferCall(token: `0x${string}`, to: `0x${string}`, amount: bigint): DepositWalletCall {
  return { target: token, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

export async function erc20Balance(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function isDeployed(address: `0x${string}`): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return !!code && code !== "0x";
}

/** Unix-seconds deadline string for WALLET batches. */
export const batchDeadline = (minutes = 30) => String(Math.floor(Date.now() / 1000) + minutes * 60);
