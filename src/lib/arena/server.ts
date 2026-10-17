import "server-only";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { NextRequest } from "next/server";
import { arenaAbi } from "./abi";
import { ARENA_ADDRESS, ARENA_CHAIN_ID, ARENA_DOMAIN, ARENA_TYPES, isArenaConfigured, type MatchStruct } from "./typed-data";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";

/** Chain + clients ------------------------------------------------------- */

const chain = ARENA_CHAIN_ID === 80002 ? polygonAmoy : polygon;
const rpc = ARENA_CHAIN_ID === 80002 ? (process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology") : POLYGON_RPC_URL;

export const arenaPublic = createPublicClient({ chain, transport: http(rpc) });

export function isOperatorConfigured(): boolean {
  return isArenaConfigured() && /^0x[0-9a-fA-F]{64}$/.test(process.env.ARENA_OPERATOR_KEY ?? "");
}

/** Patoli's operator EOA: pays gas for settlements and relayed withdrawals. Holds no user funds. */
export function operatorWallet() {
  if (!isOperatorConfigured()) throw new Error("Arena operator no configurado");
  const account = privateKeyToAccount(process.env.ARENA_OPERATOR_KEY as Hex);
  return createWalletClient({ account, chain, transport: http(rpc) });
}

/** On-chain reads ---------------------------------------------------------- */

export async function arenaBalance(eoa: Hex): Promise<bigint> {
  return arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "balanceOf", args: [eoa] });
}
export async function arenaNonce(eoa: Hex): Promise<bigint> {
  return arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "nonces", args: [eoa] });
}
export async function arenaPendingWithdraw(eoa: Hex): Promise<{ amount: bigint; to: Hex; readyAt: bigint }> {
  const [amount, to, readyAt] = await arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "pendingWithdraw", args: [eoa] });
  return { amount, to, readyAt };
}
export async function arenaLimits(): Promise<{ min: bigint; max: bigint }> {
  const [min, max] = await Promise.all([
    arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "minStake" }),
    arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "maxStake" }),
  ]);
  return { min, max };
}

/** Signature checks (EOA or ERC-1271, via the chain) --------------------- */

export function verifyMatchSig(m: MatchStruct, signer: Hex, signature: Hex) {
  return arenaPublic.verifyTypedData({ address: signer, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "Match", message: { ...m }, signature });
}
export function verifyCommitSig(matchId: Hex, round: number, hash: Hex, signer: Hex, signature: Hex) {
  return arenaPublic.verifyTypedData({ address: signer, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "Commit", message: { matchId, round, hash }, signature });
}
export function verifyResultSig(matchId: Hex, winner: Hex, signer: Hex, signature: Hex) {
  return arenaPublic.verifyTypedData({ address: signer, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "Result", message: { matchId, winner }, signature });
}
export function verifyWithdrawSig(msg: { player: Hex; to: Hex; amount: bigint; nonce: bigint; deadline: bigint }, signature: Hex) {
  return arenaPublic.verifyTypedData({ address: msg.player, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "Withdraw", message: msg, signature });
}

/** Auth: Magic DID token → our profile (id, eoa, wallet) ------------------- */

export interface ArenaIdentity {
  profileId: string;
  eoa: Hex;
  wallet: Hex;
  handle: string;
}

export async function arenaIdentity(req: NextRequest): Promise<ArenaIdentity | null> {
  if (!isSupabaseConfigured() || !isMagicAdminConfigured()) return null;
  const id = await verifyDidToken(bearer(req));
  if (!id) return null;
  const db = supabaseAdmin();
  const { data: priv } = await db.from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  if (!priv) return null;
  const { data: p } = await db.from("profiles").select("id, eoa, wallet, handle, is_banned").eq("id", priv.profile_id as string).maybeSingle();
  if (!p || p.is_banned) return null;
  return { profileId: p.id as string, eoa: (p.eoa as string) as Hex, wallet: (p.wallet as string) as Hex, handle: p.handle as string };
}

/** Transactions ------------------------------------------------------------ */

export interface SettleItem {
  m: MatchStruct;
  sigA: Hex;
  sigB: Hex;
  winner: Hex;
  resSigA: Hex;
  resSigB: Hex;
}

export async function sendSettleBatch(items: SettleItem[]): Promise<Hex> {
  const wallet = operatorWallet();
  const hash = await wallet.writeContract({
    address: ARENA_ADDRESS,
    abi: arenaAbi,
    functionName: "settleBatch",
    args: [items.map((it) => ({ m: it.m, sigA: it.sigA, sigB: it.sigB, winner: it.winner, resSigA: it.resSigA, resSigB: it.resSigB }))],
  });
  return hash;
}

export async function sendWithdrawWithSig(player: Hex, to: Hex, amount: bigint, deadline: bigint, sig: Hex): Promise<Hex> {
  const wallet = operatorWallet();
  return wallet.writeContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "withdrawWithSig", args: [player, to, amount, deadline, sig] });
}

export async function waitForTx(hash: Hex) {
  return arenaPublic.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
}
