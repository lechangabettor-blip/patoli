import { createPublicClient, encodeFunctionData, erc20Abi, http } from "viem";
import { polygon } from "viem/chains";
import { OperationType, type SafeTransaction } from "@polymarket/builder-relayer-client";
import {
  CTF_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  POLYGON_RPC_URL,
  USDC_E_ADDRESS,
} from "./constants";

const MAX_UINT256 = (1n << 256n) - 1n;

const erc1155Abi = [
  {
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });

const USDC_SPENDERS = [CTF_ADDRESS, NEG_RISK_ADAPTER_ADDRESS, CTF_EXCHANGE_ADDRESS, NEG_RISK_CTF_EXCHANGE_ADDRESS] as const;
const OUTCOME_SPENDERS = [CTF_EXCHANGE_ADDRESS, NEG_RISK_CTF_EXCHANGE_ADDRESS, NEG_RISK_ADAPTER_ADDRESS] as const;

export async function checkAllApprovals(safe: `0x${string}`): Promise<boolean> {
  const threshold = 1_000_000_000_000n; // 1M USDC in 6 decimals
  const usdc = await Promise.all(
    USDC_SPENDERS.map((spender) =>
      publicClient
        .readContract({ address: USDC_E_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [safe, spender] })
        .then((a) => a >= threshold)
        .catch(() => false),
    ),
  );
  const ctf = await Promise.all(
    OUTCOME_SPENDERS.map((spender) =>
      publicClient
        .readContract({ address: CTF_ADDRESS, abi: erc1155Abi, functionName: "isApprovedForAll", args: [safe, spender] })
        .catch(() => false),
    ),
  );
  return [...usdc, ...ctf].every(Boolean);
}

export function buildApprovalTxs(): SafeTransaction[] {
  const txs: SafeTransaction[] = [];
  for (const spender of USDC_SPENDERS) {
    txs.push({
      to: USDC_E_ADDRESS,
      operation: OperationType.Call,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, MAX_UINT256] }),
      value: "0",
    });
  }
  for (const spender of OUTCOME_SPENDERS) {
    txs.push({
      to: CTF_ADDRESS,
      operation: OperationType.Call,
      data: encodeFunctionData({ abi: erc1155Abi, functionName: "setApprovalForAll", args: [spender, true] }),
      value: "0",
    });
  }
  return txs;
}

export function buildUsdcTransferTx(recipient: `0x${string}`, amount: bigint): SafeTransaction {
  return {
    to: USDC_E_ADDRESS,
    operation: OperationType.Call,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] }),
    value: "0",
  };
}
