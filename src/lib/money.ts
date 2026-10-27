import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ttlCache } from "@/lib/ttl-cache";
import { ARENA_ADDRESS, ARENA_ROUTER_ADDRESS, isRouterConfigured } from "@/lib/arena/typed-data";
import { routerAbi } from "@/lib/arena/abi";
import { publicClient } from "@/lib/polymarket/v2";
import {
  COLLATERAL_OFFRAMP_ADDRESS,
  COLLATERAL_ONRAMP_ADDRESS,
  CTF_ADDRESS,
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  POLYGON_RPC_URL,
  PUSD_ADDRESS,
  USDC_E_ADDRESS,
  USDC_NATIVE_ADDRESS,
  V2_NEG_RISK_EXCHANGE_ADDRESS,
  V2_POSITION_MANAGER_ADDRESS,
  V2_PROTOCOL_EXCHANGE_ADDRESS,
  V2_ROUTER_ADDRESS,
  V2_STANDARD_EXCHANGE_ADDRESS,
} from "@/lib/polymarket/constants";
import type { MoneyRow } from "@/types/social";

/**
 * "Dinero": the owner's own money movements, read from the chain (deposits arrive from
 * outside the app, so the DB cannot know them). Alchemy's asset-transfer index gives every
 * USDC.e / USDC / pUSD transfer in or out of the deposit wallet in one call per direction.
 * Bets, winnings, redeems and the USDC→pUSD wrap are Polymarket plumbing and stay hidden:
 * they already show as picks. What remains is what the user did with money.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
/** The first Arena + router (2026-10-19, retired the same week); their moves are still in wallets. */
const ARENA_V1 = "0xa2b447c73935ee0e777f3b41251610ed47c9f612";
const ROUTER_V1 = "0x6418a4bf4251F66156EFa268384C7AB7aBF92638" as const;

/** The per-user deposit forwarder of a router (CREATE2 address; a plain pUSD transfer to it = Arena deposit). */
async function forwarderOn(router: `0x${string}`, eoa: string): Promise<string | null> {
  try {
    const a = await publicClient.readContract({ address: router, abi: routerAbi, functionName: "forwarderOf", args: [eoa as `0x${string}`] });
    return (a as string).toLowerCase();
  } catch {
    return null;
  }
}
const PLUMBING = new Set(
  [
    COLLATERAL_ONRAMP_ADDRESS,
    CTF_ADDRESS,
    NEG_RISK_ADAPTER_ADDRESS,
    CTF_COLLATERAL_ADAPTER_ADDRESS,
    NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
    V2_PROTOCOL_EXCHANGE_ADDRESS,
    V2_STANDARD_EXCHANGE_ADDRESS,
    V2_NEG_RISK_EXCHANGE_ADDRESS,
    V2_POSITION_MANAGER_ADDRESS,
    V2_ROUTER_ADDRESS,
  ].map((a) => a.toLowerCase()),
);
const TOKENS = [USDC_E_ADDRESS, USDC_NATIVE_ADDRESS, PUSD_ADDRESS];
const PUSD = PUSD_ADDRESS.toLowerCase();

interface Transfer {
  hash: string;
  from: string;
  to: string;
  value: number | null;
  rawContract: { address: string | null };
  metadata: { blockTimestamp: string };
}

const cache = ttlCache<string, MoneyRow[]>(30_000);

export async function loadMoney(wallet: string, eoa: string | null, profileId: string): Promise<MoneyRow[]> {
  const w = wallet.toLowerCase();
  const hit = cache.get(w);
  if (hit) return hit;

  const [ins, outs, fwdV2, fwdV1] = await Promise.all([
    transfers({ toAddress: w }),
    transfers({ fromAddress: w }),
    eoa && isRouterConfigured() ? forwarderOn(ARENA_ROUTER_ADDRESS, eoa) : null,
    eoa ? forwarderOn(ROUTER_V1, eoa) : null,
  ]);
  const forwarders = new Set([fwdV2, fwdV1].filter((x): x is string => !!x));
  const arenas = new Set([(ARENA_ADDRESS || "").toLowerCase(), ARENA_V1].filter(Boolean));
  // A wrap = USDC/USDC.e leaving and the same amount of pUSD minted back, in the same tx
  // (USDC.e onramp) or within a couple of hours (native USDC goes through Polymarket's bridge
  // and comes back as pUSD in a later tx). Hide both legs: the deposit itself is the row.
  const mints = ins
    .filter((t) => t.from.toLowerCase() === ZERO && (t.rawContract.address ?? "").toLowerCase() === PUSD && t.value)
    .map((t) => ({ value: t.value!, at: Date.parse(t.metadata.blockTimestamp), used: false }));
  const isWrap = (t: Transfer) => {
    const at = Date.parse(t.metadata.blockTimestamp);
    const m = mints.find((x) => !x.used && Math.abs(x.value - (t.value ?? 0)) < 0.01 && x.at >= at && x.at - at < 2 * 3600_000);
    if (m) m.used = true;
    return !!m;
  };

  // Who is on the other side: other users (tips) by deposit wallet, with the tips table as the
  // authoritative label when we recorded the tip ourselves.
  const db = supabaseAdmin();
  const others = new Set([...ins.map((t) => t.from), ...outs.map((t) => t.to)].map((a) => a.toLowerCase()).filter((a) => a !== w && a !== ZERO && !PLUMBING.has(a)));
  const [{ data: users }, { data: tips }] = await Promise.all([
    others.size ? db.from("profiles").select("wallet, handle").in("wallet", [...others]) : Promise.resolve({ data: [] as { wallet: string; handle: string }[] }),
    db.from("tips").select("tx_hash, from_profile, to_profile, amount").or(`from_profile.eq.${profileId},to_profile.eq.${profileId}`),
  ]);
  const handleByWallet = new Map((users ?? []).map((u) => [String(u.wallet).toLowerCase(), String(u.handle)]));
  const tipByHash = new Map((tips ?? []).map((t) => [String(t.tx_hash).toLowerCase(), t]));

  const rows: MoneyRow[] = [];
  for (const t of ins) {
    const from = t.from.toLowerCase();
    const token = (t.rawContract.address ?? "").toLowerCase();
    if (!t.value || from === w || PLUMBING.has(from)) continue;
    if (from === ZERO) continue; // pUSD mint: the wrap of a deposit, or a redeem (shows as a pick)
    if (arenas.has(from)) rows.push(row(t, "arena_in", t.value, token));
    else if (handleByWallet.has(from) || tipByHash.has(t.hash.toLowerCase())) rows.push(row(t, "tip_in", t.value, token, handleByWallet.get(from)));
    else rows.push(row(t, "deposit", t.value, token));
  }
  for (const t of outs) {
    const to = t.to.toLowerCase();
    const token = (t.rawContract.address ?? "").toLowerCase();
    if (!t.value || to === w || PLUMBING.has(to)) continue;
    if (token !== PUSD && (to === PUSD || isWrap(t))) continue; // USDC → pUSD wrap
    if (token === PUSD && (to === COLLATERAL_OFFRAMP_ADDRESS.toLowerCase() || to === PUSD || to === ZERO)) rows.push(row(t, "withdraw", -t.value, token));
    else if (forwarders.has(to)) rows.push(row(t, "arena_out", -t.value, token));
    else if (handleByWallet.has(to) || tipByHash.has(t.hash.toLowerCase())) rows.push(row(t, "tip_out", -t.value, token, handleByWallet.get(to)));
    else rows.push(row(t, "send", -t.value, token));
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return cache.set(w, rows);
}

function row(t: Transfer, kind: MoneyRow["kind"], amount: number, token: string, handle?: string): MoneyRow {
  return { hash: t.hash, at: t.metadata.blockTimestamp, kind, amount: Math.round(amount * 1e6) / 1e6, asset: token === PUSD ? "pUSD" : "USDC", handle };
}

/** Every ERC-20 transfer of our three tokens for one side of the wallet, newest first (≤ 3 pages). */
async function transfers(side: { toAddress: string } | { fromAddress: string }): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await fetch(POLYGON_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [{ fromBlock: "0x0", toBlock: "latest", ...side, contractAddresses: TOKENS, category: ["erc20"], withMetadata: true, maxCount: "0x3e8", order: "desc", ...(pageKey ? { pageKey } : {}) }],
      }),
    });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = (await r.json()) as { result?: { transfers: Transfer[]; pageKey?: string }; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    out.push(...(j.result?.transfers ?? []));
    pageKey = j.result?.pageKey;
    if (!pageKey) break;
  }
  return out;
}
