import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbi, type Chain } from "viem";
import { polygon } from "viem/chains";
import type { DepositWalletCall } from "@polymarket/builder-relayer-client";
import {
  COLLATERAL_ONRAMP_ADDRESS,
  CTF_ADDRESS,
  POLYGON_RPC_URL,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
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

const onrampAbi = parseAbi(["function wrap(address _asset, address _to, uint256 _amount)"]);

// pUSD spenders (ERC-20 approve)
const PUSD_SPENDERS = [V2_PROTOCOL_EXCHANGE_ADDRESS, V2_STANDARD_EXCHANGE_ADDRESS, V2_NEG_RISK_EXCHANGE_ADDRESS] as const;
// Conditional tokens operators (ERC-1155 setApprovalForAll)
const CTF_OPERATORS = [V2_STANDARD_EXCHANGE_ADDRESS, V2_NEG_RISK_EXCHANGE_ADDRESS] as const;
// PositionManager operator for the Protocol V2 exchange
const PM_OPERATORS = [V2_PROTOCOL_EXCHANGE_ADDRESS] as const;

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
export function buildWrapCalls(wallet: `0x${string}`, amount: bigint): DepositWalletCall[] {
  return [
    { target: USDC_E_ADDRESS, value: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COLLATERAL_ONRAMP_ADDRESS, amount] }) },
    { target: COLLATERAL_ONRAMP_ADDRESS, value: "0", data: encodeFunctionData({ abi: onrampAbi, functionName: "wrap", args: [USDC_E_ADDRESS, wallet, amount] }) },
  ];
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
