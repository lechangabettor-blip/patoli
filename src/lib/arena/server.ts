import "server-only";
import { createPublicClient, createWalletClient, http, verifyTypedData, type Hex, getAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { NextRequest } from "next/server";
import { arenaAbi, routerAbi } from "./abi";
import { ARENA_ADDRESS,
  ARENA_DEPLOY_BLOCK, ARENA_CHAIN_ID, ARENA_DOMAIN, ARENA_TYPES, ARENA_ROUTER_ADDRESS, isArenaConfigured, isRouterConfigured, type MatchStruct } from "./typed-data";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase/server";
import { withJobLock } from "@/lib/job-lock";

/** Chain + clients ------------------------------------------------------- */

const chain = ARENA_CHAIN_ID === 80002 ? polygonAmoy : polygon;
const rpc = ARENA_CHAIN_ID === 80002 ? (process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology") : POLYGON_RPC_URL;

const arenaPublic = createPublicClient({ chain, transport: http(rpc) });
/** Log scans only (Alchemy's free tier limits eth_getLogs to 10 blocks; this public node allows 10k). */
const logsPublic = createPublicClient({ chain, transport: http(process.env.ARENA_LOGS_RPC_URL || "https://polygon-bor-rpc.publicnode.com") });

export function isOperatorConfigured(): boolean {
  return isArenaConfigured() && /^0x[0-9a-fA-F]{64}$/.test(process.env.ARENA_OPERATOR_KEY ?? "");
}

/** Patoli's operator EOA: pays gas for settlements and relayed withdrawals. Holds no user funds. */
function operatorWallet() {
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
/**
 * The on-chain Settled event for a match id, if any. matchStatus alone is not proof: the contract keys
 * it by the client-chosen id, so a settlement is only ours if the event's players and stake match.
 * Public RPCs cap eth_getLogs at 10k blocks, so we scan forward in windows from the block at
 * `since` (the match's finish time; settlement can only come after it), up to ~3 days.
 */
export async function arenaSettledEvent(matchId: Hex, since: Date): Promise<{ playerA: Hex; playerB: Hex; winner: Hex; stake: bigint; tx: Hex } | null> {
  if ((await arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "matchStatus", args: [matchId] })) !== 1) return null;
  const latest = await logsPublic.getBlock();
  const target = BigInt(Math.floor(since.getTime() / 1000)) - 120n;
  // Last block at or before `target` by binary search on timestamps (block times drift too much to estimate).
  let lo = ARENA_DEPLOY_BLOCK, hi = latest.number;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const b = await logsPublic.getBlock({ blockNumber: mid });
    if (b.timestamp <= target) lo = mid;
    else hi = mid - 1n;
  }
  let from = lo;
  const WINDOW = 9_999n;
  for (let i = 0; i < 13 && from <= latest.number; i++, from += WINDOW + 1n) {
    const to = from + WINDOW > latest.number ? latest.number : from + WINDOW;
    const logs = await logsPublic.getLogs({ address: ARENA_ADDRESS, event: getAbiItem({ abi: arenaAbi, name: "Settled" }), args: { matchId }, fromBlock: from, toBlock: to });
    const l = logs[0];
    if (l) return { playerA: l.args.playerA as Hex, playerB: l.args.playerB as Hex, winner: l.args.winner as Hex, stake: l.args.stake as bigint, tx: l.transactionHash };
  }
  return null;
}
export async function arenaLimits(): Promise<{ min: bigint; max: bigint }> {
  const [min, max] = await Promise.all([
    arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "minStake" }),
    arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "maxStake" }),
  ]);
  return { min, max };
}

/** Signature checks (EOA or ERC-1271, via the chain) --------------------- */

const SECP256K1_N_HALF = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0");
/**
 * Accept only what OpenZeppelin's ECDSA.recover accepts on-chain: exactly 65 bytes,
 * low-s, v ∈ {27, 28}. Anything else is rejected here so a signature that verifies
 * off-chain can never be one the contract later refuses (or vice versa).
 */
function isCanonicalSig(sig: string): sig is Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const s = BigInt("0x" + sig.slice(66, 130));
  const v = parseInt(sig.slice(130, 132), 16);
  return s > 0n && s <= SECP256K1_N_HALF && (v === 27 || v === 28);
}

/**
 * Fast path: pure ECDSA recovery in-process (what every Magic EOA produces, ~1ms).
 * Fallback: on-chain verification (ERC-1271 contract wallets), one RPC round trip.
 */
async function verifyTyped(args: { address: Hex; primaryType: "Match" | "Commit" | "Withdraw"; message: Record<string, unknown>; signature: Hex }): Promise<boolean> {
  if (!isCanonicalSig(args.signature)) return false;
  try {
    const ok = await verifyTypedData({ address: args.address, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: args.primaryType, message: args.message as never, signature: args.signature });
    if (ok) return true;
  } catch {
    /* fall through */
  }
  return arenaPublic.verifyTypedData({ address: args.address, domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: args.primaryType, message: args.message as never, signature: args.signature });
}

export function verifyMatchSig(m: MatchStruct, signer: Hex, signature: Hex) {
  return verifyTyped({ address: signer, primaryType: "Match", message: { ...m }, signature });
}
export function verifyCommitSig(matchId: Hex, round: number, hash: Hex, signer: Hex, signature: Hex) {
  return verifyTyped({ address: signer, primaryType: "Commit", message: { matchId, round, hash }, signature });
}
export function verifyWithdrawSig(msg: { player: Hex; to: Hex; amount: bigint; nonce: bigint; deadline: bigint }, signature: Hex) {
  return verifyTyped({ address: msg.player, primaryType: "Withdraw", message: { ...msg }, signature });
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

// All operator writes go through one queue: a single EOA sending concurrent txs (sweep +
// settle cron + withdraw relay) would race on the nonce and drop transactions. The in-process
// queue covers one instance; the `arena_operator` lease (job_locks) covers the others, since on
// Vercel the cron, a user's sweep and a withdrawal can each run on a different instance.
let opQueue: Promise<unknown> = Promise.resolve();
function withOperator<T>(fn: () => Promise<T>): Promise<T> {
  const run = opQueue.then(
    () => locked(fn),
    () => locked(fn),
  );
  opQueue = run.catch(() => undefined);
  return run;
}
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  // The lease only needs to cover the send (nonce assignment + broadcast), not the confirmation.
  const out = await withJobLock("arena_operator", 30, fn, 25_000);
  // `status` lets the route helper answer 503 with this message instead of a masked 500.
  if (out === undefined) throw Object.assign(new Error("El operador está ocupado. Intenta de nuevo en unos segundos."), { status: 503 });
  return out;
}

/** POL left in the operator EOA, in whole units (it pays gas for every settle, claim and relayed withdrawal). */
export async function operatorGasBalance(): Promise<number> {
  const account = privateKeyToAccount(process.env.ARENA_OPERATOR_KEY as Hex);
  const wei = await arenaPublic.getBalance({ address: account.address });
  return Number(wei) / 1e18;
}

export interface ClaimCommit { round: number; player: Hex; hash: Hex; sig: Hex; opSig: Hex }
export interface ClaimReveal { round: number; player: Hex; move: number; salt: Hex; opSig: Hex }

/** A completed match: the players' signed, operator-acked moves. The chain replays them. */
export interface SettleItem {
  m: MatchStruct;
  sigA: Hex;
  sigB: Hex;
  commits: ClaimCommit[];
  reveals: ClaimReveal[];
}

export async function sendSettleBatch(items: SettleItem[]): Promise<Hex> {
  return withOperator(() => operatorWallet().writeContract({
    address: ARENA_ADDRESS,
    abi: arenaAbi,
    functionName: "settleBatch",
    args: [items.map((it) => ({ m: it.m, sigA: it.sigA, sigB: it.sigB, commits: it.commits, reveals: it.reveals }))],
  }));
}

export async function sendWithdrawWithSig(player: Hex, to: Hex, amount: bigint, deadline: bigint, sig: Hex): Promise<Hex> {
  return withOperator(() => operatorWallet().writeContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "withdrawWithSig", args: [player, to, amount, deadline, sig] }));
}

/** Operator acknowledgements: "this move reached Patoli inside its window". Required by the contract's replay. */
export function signCommitAck(matchId: Hex, round: number, player: Hex, hash: Hex): Promise<Hex> {
  const account = privateKeyToAccount(process.env.ARENA_OPERATOR_KEY as Hex);
  return account.signTypedData({ domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "CommitAck", message: { matchId, round, player, hash } });
}
export function signRevealAck(matchId: Hex, round: number, player: Hex, move: number, salt: Hex): Promise<Hex> {
  const account = privateKeyToAccount(process.env.ARENA_OPERATOR_KEY as Hex);
  return account.signTypedData({ domain: ARENA_DOMAIN, types: ARENA_TYPES, primaryType: "RevealAck", message: { matchId, round, player, move, salt } });
}

/** Operator files a dispute claim with every signed artifact we hold (the chain replays the game). */
export async function sendClaim(m: MatchStruct, sigA: Hex, sigB: Hex, commits: ClaimCommit[], reveals: ClaimReveal[]): Promise<Hex> {
  return withOperator(() => operatorWallet().writeContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "claim", args: [m, sigA, sigB, commits, reveals] }));
}
export async function sendFinalize(m: MatchStruct, sigA: Hex, sigB: Hex): Promise<Hex> {
  return withOperator(() => operatorWallet().writeContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "finalize", args: [m, sigA, sigB] }));
}
export async function readClaim(matchId: Hex): Promise<{ claimant: Hex; winner: Hex; evidence: number; finalizeAt: bigint }> {
  const [claimant, winner, evidence, finalizeAt] = await arenaPublic.readContract({ address: ARENA_ADDRESS, abi: arenaAbi, functionName: "claims", args: [matchId] });
  return { claimant, winner, evidence, finalizeAt };
}

/** Operator sweeps a user's forwarder into the Arena (permissionless on-chain; we pay gas). */
export async function sendSweep(user: Hex): Promise<Hex> {
  if (!isRouterConfigured()) throw new Error("router no configurado");
  return withOperator(() => operatorWallet().writeContract({ address: ARENA_ROUTER_ADDRESS, abi: routerAbi, functionName: "sweep", args: [user] }));
}
export async function forwarderOf(user: Hex): Promise<Hex> {
  return arenaPublic.readContract({ address: ARENA_ROUTER_ADDRESS, abi: routerAbi, functionName: "forwarderOf", args: [user] });
}

export async function waitForTx(hash: Hex) {
  return arenaPublic.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
}
