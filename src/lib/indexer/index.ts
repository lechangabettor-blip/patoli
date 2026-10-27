import "server-only";
import type { GammaMarket } from "@/lib/polymarket/gamma-raw";
import { supabaseAdmin } from "@/lib/supabase/server";
import { CLOB_API_URL, GAMMA_API_URL, PATOLI_BUILDER_CODE, isBuilderCodeValid } from "@/lib/polymarket/constants";
import { LEAGUES } from "@/lib/polymarket/leagues";
import { parseAbi, type Hex } from "viem";
import { publicClient } from "@/lib/polymarket/v2";
import { CTF_ADDRESS } from "@/lib/polymarket/constants";

/**
 * The indexer: turns Polymarket's public builder-trades feed (every fill that
 * carries Patoli's code) into `bets`, caches market metadata from Gamma into
 * `markets`, and settles bets once markets resolve. Idempotent; safe to run
 * every few minutes. Everything here is rebuildable from public data.
 */

interface BuilderTrade {
  id: string;
  tradeType: string;
  market: string; // condition id
  assetId: string; // token id
  side: "BUY" | "SELL";
  size: string;
  sizeUsdc: string;
  price: string;
  status: string;
  outcome: string;
  outcomeIndex: number;
  maker: string;
  transactionHash?: string;
  matchTime: string; // unix seconds
  feeUsdc?: string;
  builderFee?: string;
  builderCode?: string;
}


export interface IndexRunResult {
  tradesSeen: number;
  betsUpserted: number;
  marketsUpserted: number;
  settled: number;
  unknownWallets: string[];
  errors: string[];
}

/**
 * Our market kind from Polymarket's sportsMarketType: base kind + period suffix.
 * "spreads" → "spread" · "first_half_spreads" → "spread_1h" · "q3_totals" → "total_q3" ·
 * "team_totals" → "team_total" · "points" → "prop_points" · anything else → "yesno" (two-way) / "other".
 */
function kindOf(type: string | undefined): string {
  const t = type ?? "";
  const period = /first_half/.test(t) ? "_1h" : /second_half/.test(t) ? "_2h" : (t.match(/^q([1-4])_/)?.[1] ? `_q${t.match(/^q([1-4])_/)![1]}` : "");
  const base = t.replace(/^(first_half_|second_half_|q[1-4]_|soccer_first_half_|soccer_second_half_|soccer_)/, "").replace(/_first_half$|_second_half$|_points$/, "");
  const map: Record<string, string> = { moneyline: "moneyline", spreads: "spread", totals: "total", team_totals: "team_total", both_teams_to_score: "btts" };
  if (map[base]) return map[base] + period;
  if (/^(points|rebounds|assists|threes|steals|blocks)$/.test(base)) return `prop_${base}`;
  if (!t) return "other";
  return "yesno" + period;
}

export async function runIndexer(opts: { maxPages?: number } = {}): Promise<IndexRunResult> {
  const res: IndexRunResult = { tradesSeen: 0, betsUpserted: 0, marketsUpserted: 0, settled: 0, unknownWallets: [], errors: [] };
  if (!isBuilderCodeValid(PATOLI_BUILDER_CODE)) {
    res.errors.push("builder code not configured");
    return res;
  }
  const db = supabaseAdmin();

  // 1. Pull trades (newest first, paginated)
  const trades: BuilderTrade[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const u = new URL(`${CLOB_API_URL}/builder/trades`);
    u.searchParams.set("builder_code", PATOLI_BUILDER_CODE);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("next_cursor", cursor);
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) {
      res.errors.push(`builder/trades ${r.status}`);
      break;
    }
    const j = (await r.json()) as { data?: BuilderTrade[]; next_cursor?: string };
    const batch = j.data ?? [];
    trades.push(...batch);
    if (!j.next_cursor || j.next_cursor === "LTE=" || batch.length === 0) break;
    cursor = j.next_cursor;
  }
  res.tradesSeen = trades.length;
  const confirmed = trades.filter((t) => /CONFIRMED|MINED/i.test(t.status) || !t.status);

  // 2. Markets we don't know yet
  const conditionIds = [...new Set(confirmed.map((t) => t.market.toLowerCase()))];
  const { data: known } = await db.from("markets").select("condition_id").in("condition_id", conditionIds);
  const knownSet = new Set((known ?? []).map((m) => m.condition_id as string));
  const missing = conditionIds.filter((c) => !knownSet.has(c));
  if (missing.length) {
    const rows = await fetchMarkets(missing);
    if (rows.length) {
      const { error } = await db.from("markets").upsert(rows, { onConflict: "condition_id" });
      if (error) res.errors.push(`markets upsert: ${error.message}`);
      else res.marketsUpserted += rows.length;
    }
    // markets Gamma couldn't resolve still need a row so bets can reference them
    const got = new Set(rows.map((r) => r.condition_id));
    const stubs = missing.filter((c) => !got.has(c)).map((c) => ({ condition_id: c, question: "Mercado", outcomes: [] }));
    if (stubs.length) await db.from("markets").upsert(stubs, { onConflict: "condition_id", ignoreDuplicates: true });
  }

  // 3. Wallet → profile
  const wallets = [...new Set(confirmed.map((t) => t.maker.toLowerCase()))];
  const { data: profs } = await db.from("profiles").select("id, wallet").in("wallet", wallets);
  const byWallet = new Map((profs ?? []).map((p) => [p.wallet as string, p.id as string]));
  res.unknownWallets = wallets.filter((w) => !byWallet.has(w));

  // 4. Upsert bets (keep status/pnl of already-settled rows)
  const { data: existing } = await db.from("bets").select("id, status").in("id", confirmed.map((t) => t.id));
  const settledIds = new Set((existing ?? []).filter((b) => b.status !== "open").map((b) => b.id as string));
  const betRows = confirmed
    .filter((t) => !settledIds.has(t.id))
    .map((t) => ({
      id: t.id,
      profile_id: byWallet.get(t.maker.toLowerCase()) ?? null,
      wallet: t.maker.toLowerCase(),
      condition_id: t.market.toLowerCase(),
      token_id: t.assetId,
      outcome_index: t.outcomeIndex,
      outcome: t.outcome,
      side: t.side,
      size: Number(t.size),
      price: Number(t.price),
      usdc: Number(t.sizeUsdc ?? Number(t.size) * Number(t.price)),
      fee_usdc: Number(t.feeUsdc ?? 0),
      builder_fee: Number(t.builderFee ?? 0),
      tx_hash: t.transactionHash ?? null,
      matched_at: new Date(Number(t.matchTime) * 1000).toISOString(),
    }));
  if (betRows.length) {
    const { error } = await db.from("bets").upsert(betRows, { onConflict: "id" });
    if (error) res.errors.push(`bets upsert: ${error.message}`);
    else res.betsUpserted = betRows.length;
  }

  // 5. Resolve markets whose game should be over
  res.settled = await settleResolvedMarkets(res.errors);

  await db.from("indexer_state").upsert({ key: "last_run", value: { at: new Date().toISOString(), ...res } }, { onConflict: "key" });
  return res;
}

type MarketRow = ReturnType<typeof toMarketRow>;

/**
 * Gamma `/markets?condition_ids=` silently drops CLOSED markets unless you ask
 * for them with `closed=true` — and the two states can't be combined in one
 * call. Settlement depends on seeing closed markets, so query both.
 */
async function fetchMarkets(conditionIds: string[]): Promise<MarketRow[]> {
  const out = new Map<string, MarketRow>();
  for (let i = 0; i < conditionIds.length; i += 20) {
    const chunk = conditionIds.slice(i, i + 20);
    for (const closed of ["true", "false"]) {
      const u = new URL(`${GAMMA_API_URL}/markets`);
      for (const c of chunk) u.searchParams.append("condition_ids", c);
      u.searchParams.set("closed", closed);
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const ms = (await r.json()) as GammaMarket[];
      for (const m of ms) {
        const row = toMarketRow(m);
        if (!out.has(row.condition_id)) out.set(row.condition_id, row);
      }
    }
  }
  return [...out.values()];
}

function toMarketRow(m: GammaMarket) {
  let outcomes: string[] = [];
  let tokens: string[] = [];
  let prices: number[] = [];
  try {
    outcomes = JSON.parse(m.outcomes ?? "[]");
    tokens = JSON.parse(m.clobTokenIds ?? "[]");
    prices = (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
  } catch {
    /* ignore */
  }
  const ev = m.events?.[0];
  const league = LEAGUES.find((l) => ev?.slug?.startsWith(`${l.slugPrefix}-`))?.id ?? null;
  const resolution = resolveFromPrices(m, prices);
  return {
    condition_id: m.conditionId.toLowerCase(),
    question: m.question,
    slug: m.slug ?? null,
    event_slug: ev?.slug?.replace(/-more-markets$/, "") ?? null,
    event_title: ev?.title ?? null,
    league,
    kind: kindOf(m.sportsMarketType),
    line: m.line == null ? null : Number(m.line),
    outcomes: outcomes.map((label, i) => ({ index: i, label, tokenId: tokens[i] ?? null })),
    game_start: m.gameStartTime ? new Date(m.gameStartTime.replace(" ", "T").replace(/\+00$/, "Z")).toISOString() : null,
    closed: !!m.closed,
    winning_index: resolution,
    resolved_at: resolution != null ? new Date().toISOString() : null,
  };
}

/** Gamma marks a resolved market closed with outcomePrices like ["1","0"]; 50/50 = void. */
function resolveFromPrices(m: GammaMarket, prices: number[]): number | null {
  if (!m.closed || prices.length === 0) return null;
  const win = prices.findIndex((p) => p >= 0.999);
  if (win >= 0) return win;
  if (prices.every((p) => Math.abs(p - 1 / prices.length) < 0.01)) return -1; // void
  return null;
}

const ctfAbi = parseAbi([
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
]);

/**
 * Resolution straight from the Conditional Tokens contract: the oracle writes the payout
 * vector the moment a market resolves — the same instant Polymarket lets the user redeem —
 * so bets flip to won/lost without waiting for Gamma to catch up. null = not resolved yet.
 */
async function resolveOnChain(conditionId: string, outcomeCount: number): Promise<number | null> {
  const id = conditionId as Hex;
  const den = await publicClient.readContract({ address: CTF_ADDRESS, abi: ctfAbi, functionName: "payoutDenominator", args: [id] });
  if (den === 0n) return null;
  const nums = await Promise.all(
    Array.from({ length: outcomeCount }, (_, i) => publicClient.readContract({ address: CTF_ADDRESS, abi: ctfAbi, functionName: "payoutNumerators", args: [id, BigInt(i)] })),
  );
  const win = nums.findIndex((n) => n === den);
  if (win >= 0) return win;
  if (nums.every((n) => n === nums[0])) return -1; // split payout = void
  return null; // partial payouts (not a sports outcome) — leave to Gamma
}

async function settleResolvedMarkets(errors: string[]): Promise<number> {
  const db = supabaseAdmin();
  // Games run 1.5–3.5 h; nothing resolves before 90 min after kickoff.
  const cutoff = new Date(Date.now() - 90 * 60_000).toISOString();
  const { data: due } = await db
    .from("markets")
    .select("condition_id, outcomes")
    .is("winning_index", null)
    .lt("game_start", cutoff)
    .order("game_start")
    .limit(50);
  if (!due?.length) return 0;

  // 1. Chain first (instant). 2. Gamma for whatever the chain could not decide.
  const resolved: { condition_id: string; winning_index: number; resolved_at: string }[] = [];
  const pending: string[] = [];
  for (const d of due) {
    const cid = d.condition_id as string;
    const n = Array.isArray(d.outcomes) ? (d.outcomes as unknown[]).length : 2;
    try {
      const w = await resolveOnChain(cid, n || 2);
      if (w != null) resolved.push({ condition_id: cid, winning_index: w, resolved_at: new Date().toISOString() });
      else pending.push(cid);
    } catch {
      pending.push(cid);
    }
  }
  if (pending.length) {
    for (const r of await fetchMarkets(pending)) {
      if (r.winning_index != null) resolved.push({ condition_id: r.condition_id, winning_index: r.winning_index, resolved_at: r.resolved_at! });
    }
  }
  if (!resolved.length) return 0;
  for (const r of resolved) {
    const { error } = await db.from("markets").update({ winning_index: r.winning_index, closed: true, resolved_at: r.resolved_at }).eq("condition_id", r.condition_id);
    if (error) errors.push(`markets resolve: ${error.message}`);
  }
  let n = 0;
  for (const r of resolved) {
    const { data: bets } = await db.from("bets").select("id, outcome_index, size, usdc, fee_usdc, builder_fee, side").eq("condition_id", r.condition_id).eq("status", "open");
    for (const b of bets ?? []) {
      let status: "won" | "lost" | "void";
      let pnl: number;
      if (r.winning_index === -1) {
        status = "void";
        pnl = 0;
      } else if (b.side === "BUY") {
        const won = b.outcome_index === r.winning_index;
        const paid = Number(b.usdc) + Number(b.fee_usdc ?? 0) + Number(b.builder_fee ?? 0);
        status = won ? "won" : "lost";
        pnl = won ? Number(b.size) - paid : -paid;
      } else {
        // SELL = closed a position early; realized P&L lives on the BUY row. Mark void for the record.
        status = "void";
        pnl = 0;
      }
      const { error: e2 } = await db.from("bets").update({ status, pnl, settled_at: new Date().toISOString() }).eq("id", b.id);
      if (!e2) n++;
    }
  }
  return n;
}
