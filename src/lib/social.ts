import "server-only";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import type { NextRequest } from "next/server";
import { CLOB_API_URL } from "@/lib/polymarket/constants";
import { supabaseAdmin } from "@/lib/supabase/server";
import { shortTeam } from "@/lib/polymarket/gamma";
import type { FeedItem, PublicProfile, StatsWindow, WindowKey } from "@/types/social";

/** Read models for profiles and the feed. Server-only. */

/**
 * What a BUY fill took out of the wallet: shares × price + Polymarket's fee. That fee already
 * contains Patoli's builder fee (live feed, 2026-10-28), so `builder_fee` is informational and
 * must never be added again. Same definition as the indexer's P&L and the SQL view's `staked`.
 */
const paidOf = (b: { usdc: unknown; fee_usdc?: unknown }) => Number(b.usdc) + Number(b.fee_usdc ?? 0);

/** pUSD received as tips, all time. Private: only the owner's own /api/me reads it. */
export async function loadTipsReceived(profileId: string): Promise<number> {
  const { data } = await supabaseAdmin().from("tips").select("amount").eq("to_profile", profileId);
  return (data ?? []).reduce((s, t) => s + Number(t.amount), 0);
}

interface ProfileRow {
  id: string;
  handle: string;
  display_name: string | null;
  avatar: string | null;
  bio: string | null;
  is_verified: boolean;
  wallet: string;
  created_at: string;
}
interface StatsRow {
  profile_id: string;
  wins: number;
  losses: number;
  voids: number;
  open_bets: number;
  pnl: number;
  staked: number;
  roi_pct: number;
  units: number;
  followers: number;
  following: number;
}

function toProfile(p: ProfileRow, s: StatsRow | undefined): PublicProfile {
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.display_name,
    avatar: p.avatar || p.handle,
    bio: p.bio,
    verified: p.is_verified,
    wallet: p.wallet,
    record: { w: Number(s?.wins ?? 0), l: Number(s?.losses ?? 0), v: Number(s?.voids ?? 0), open: Number(s?.open_bets ?? 0) },
    pnl: Number(s?.pnl ?? 0),
    staked: Number(s?.staked ?? 0),
    roi: Number(s?.roi_pct ?? 0),
    units: Number(s?.units ?? 0),
    followers: Number(s?.followers ?? 0),
    following: Number(s?.following ?? 0),
    battles: { w: 0, l: 0, d: 0, pnl: 0 },
    createdAt: p.created_at,
  };
}

interface ArenaStatsRow {
  profile_id: string;
  wins: number | string;
  losses: number | string;
  draws: number | string;
  pnl: number | string;
}

async function attachBattleStats(profiles: PublicProfile[]): Promise<void> {
  if (profiles.length === 0) return;
  const { data } = await supabaseAdmin().from("arena_stats").select("*").in("profile_id", profiles.map((p) => p.id));
  const m = new Map((data ?? []).map((r) => [(r as ArenaStatsRow).profile_id, r as ArenaStatsRow]));
  for (const p of profiles) {
    const r = m.get(p.id);
    if (r) p.battles = { w: Number(r.wins), l: Number(r.losses), d: Number(r.draws), pnl: Number(r.pnl) };
  }
}

export async function loadProfile(by: { id?: string; handle?: string }, viewerId?: string | null): Promise<PublicProfile | null> {
  const db = supabaseAdmin();
  let q = db.from("profiles").select("id, handle, display_name, avatar, bio, is_verified, wallet, created_at").eq("is_banned", false);
  q = by.id ? q.eq("id", by.id) : q.eq("handle", (by.handle ?? "").toLowerCase());
  const { data: p } = await q.maybeSingle<ProfileRow>();
  if (!p) return null;
  // Everything below depends only on the profile row: one round trip instead of four in a row.
  const isMe = !!viewerId && viewerId === p.id;
  const [{ data: s }, windows, { data: f }] = await Promise.all([
    db.from("profile_stats").select("*").eq("profile_id", p.id).maybeSingle<StatsRow>(),
    loadWindows(p.id),
    viewerId && !isMe ? db.from("follows").select("follower_id").eq("follower_id", viewerId).eq("followee_id", p.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const profile = toProfile(p, s ?? undefined);
  await attachBattleStats([profile]);
  profile.windows = windows;
  if (viewerId) {
    profile.isMe = isMe;
    if (!isMe) profile.isFollowing = !!f;
  }
  return profile;
}

const WINDOW_MS: Record<WindowKey, number> = { d7: 7 * 86_400_000, d30: 30 * 86_400_000, all: Infinity };

/**
 * Rolling records by settlement time: últimos 7 días, últimos 30 días, todo. Computed from the
 * bets and battles themselves, so any past window is always recoverable (no snapshots).
 */
async function loadWindows(profileId: string): Promise<Record<WindowKey, StatsWindow> | undefined> {
  const db = supabaseAdmin();
  const [{ data: bets, error: betsError }, { data: matches }] = await Promise.all([
    db.from("bets").select("status, side, size, price, usdc, fee_usdc, pnl, settled_at").eq("profile_id", profileId).neq("status", "open"),
    db
      .from("arena_matches")
      .select("player_a, eoa_a, eoa_b, stake, winner_eoa, finished_at, created_at")
      .or(`player_a.eq.${profileId},player_b.eq.${profileId}`)
      .in("status", ["finished", "ready", "settled", "disputed"]), // same set as loadBattles
  ]);
  // Until migration 0009 (settled_at) is applied the bets query fails: fall back to all-time numbers.
  if (betsError) return undefined;
  const now = Date.now();
  const empty = (): StatsWindow => ({ sports: { w: 0, l: 0, v: 0, units: 0, pnl: 0, staked: 0, roi: 0 }, battles: { w: 0, l: 0, d: 0, pnl: 0 } });
  const out: Record<WindowKey, StatsWindow> = { d7: empty(), d30: empty(), all: empty() };
  const keys = (at: string | null) => {
    const age = at ? now - Date.parse(at) : Infinity;
    return (Object.keys(WINDOW_MS) as WindowKey[]).filter((k) => age <= WINDOW_MS[k]);
  };
  for (const b of bets ?? []) {
    if (b.side !== "BUY") continue;
    const paid = paidOf(b);
    const price = Number(b.price);
    for (const k of keys(b.settled_at as string | null)) {
      const s = out[k].sports;
      if (b.status === "won") {
        s.w++;
        s.units += price > 0 ? 1 / price - 1 : 0;
        s.pnl += Number(b.size) - paid;
        s.staked += paid;
      } else if (b.status === "lost") {
        s.l++;
        s.units -= 1;
        s.pnl -= paid;
        s.staked += paid;
      } else {
        // void = push for Unidades, but the money moved (a split payout returns 1/n per share)
        s.v++;
        s.pnl += Number(b.pnl ?? 0);
        s.staked += paid;
      }
    }
  }
  for (const m of matches ?? []) {
    const mine = (m.player_a === profileId ? m.eoa_a : m.eoa_b) as string;
    const w = (m.winner_eoa as string | null)?.toLowerCase();
    const result = !w ? "d" : w === mine.toLowerCase() ? "w" : "l";
    for (const k of keys((m.finished_at ?? m.created_at) as string)) {
      const bt = out[k].battles;
      if (result === "w") {
        bt.w++;
        bt.pnl += Number(m.stake);
      } else if (result === "l") {
        bt.l++;
        bt.pnl -= Number(m.stake);
      } else bt.d++;
    }
  }
  for (const k of Object.keys(out) as WindowKey[]) {
    const s = out[k].sports;
    s.roi = s.staked > 0 ? (s.pnl / s.staked) * 100 : 0;
  }
  return out;
}

/** Unidades settled in the last 7 days per profile (one query for the whole list). Mutates and returns `profiles`. */
async function attachWeekUnits(profiles: PublicProfile[]): Promise<PublicProfile[]> {
  if (profiles.length === 0) return profiles;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from("bets")
    .select("profile_id, status, price")
    .in("profile_id", profiles.map((p) => p.id))
    .eq("side", "BUY")
    .in("status", ["won", "lost"])
    .gte("settled_at", since);
  const units = new Map<string, number>();
  const count = new Map<string, number>();
  for (const b of error ? [] : (data ?? [])) {
    const pid = b.profile_id as string;
    const price = Number(b.price);
    units.set(pid, (units.get(pid) ?? 0) + (b.status === "won" ? (price > 0 ? 1 / price - 1 : 0) : -1));
    count.set(pid, (count.get(pid) ?? 0) + 1);
  }
  for (const p of profiles) {
    p.units7 = units.get(p.id) ?? 0;
    p.settled7 = count.get(p.id) ?? 0;
  }
  return profiles;
}

/**
 * Profiles for Buscar and the people rail. With a query: name matches. Without one (the rail):
 * everyone who had a sports pick settle in the last 7 days, best week first by Unidades
 * (LeChanga, 2026-10-28: the rail is the week's table, not a sample of 8). When nobody has
 * settled anything this week, fall back to the old top list so the rail is never empty.
 */
export async function searchProfiles(q: string, limit = 20, rail = false): Promise<PublicProfile[]> {
  const db = supabaseAdmin();
  const needle = q.toLowerCase().replace(/[^a-z0-9_ ]/g, "");
  let query = db.from("profiles").select("id, handle, display_name, avatar, bio, is_verified, wallet, created_at").eq("is_banned", false).limit(needle ? limit : 200);
  query = needle ? query.or(`handle.ilike.%${needle}%,display_name.ilike.%${needle}%`) : query.order("created_at", { ascending: false });
  const { data: rows } = await query;
  if (!rows?.length) return [];
  const { data: stats } = await db.from("profile_stats").select("*").in("profile_id", rows.map((r) => r.id));
  const sm = new Map((stats ?? []).map((s) => [s.profile_id as string, s as StatsRow]));
  const out = (rows as ProfileRow[]).map((r) => toProfile(r, sm.get(r.id)));
  await Promise.all([attachBattleStats(out), attachWeekUnits(out)]);
  if (!needle) {
    out.sort((a, b) => (b.units7 ?? 0) - (a.units7 ?? 0) || b.record.open - a.record.open || b.createdAt.localeCompare(a.createdAt));
    if (rail) {
      const active = out.filter((p) => (p.settled7 ?? 0) > 0);
      if (active.length) return active;
    }
    return out.slice(0, limit);
  }
  return out;
}

const MARKET_LABEL: Record<string, FeedItem["market"]> = { moneyline: "ML", spread: "Spread", total: "Total", team_total: "Total", btts: "BTTS", prop: "Prop", yesno: "Otro" };
const PERIOD_TEXT: Record<string, string> = { "1h": "1ª mitad", "2h": "2ª mitad", q1: "1er cuarto", q2: "2º cuarto", q3: "3er cuarto", q4: "4º cuarto", f5: "1ras 5 entradas" };
const STAT_SHORT: Record<string, string> = { points: "pts", rebounds: "reb", assists: "ast", threes: "triples", steals: "robos", blocks: "bloqueos" };

/** "spread_1h" → { base: "spread", period: "1h", stat: undefined } · "prop_points" → { base: "prop", stat: "points" } */
function splitKind(kind: string): { base: string; period: string | null; stat?: string } {
  const m = kind.match(/^(.*?)(?:_(1h|2h|q[1-4]|f5))?$/)!;
  const base = m[1];
  if (base.startsWith("prop_")) return { base: "prop", period: null, stat: base.slice(5) };
  return { base, period: m[2] ?? null };
}

interface BetRow {
  id: string;
  profile_id: string | null;
  outcome: string;
  outcome_index: number;
  side: string;
  size: number;
  price: number;
  usdc: number;
  fee_usdc: number;
  builder_fee: number;
  status: FeedItem["status"];
  pnl: number | null;
  tx_hash: string | null;
  matched_at: string;
  token_id: string;
  markets: {
    question: string;
    event_title: string | null;
    event_slug: string | null;
    league: string | null;
    kind: string | null;
    line: number | null;
    game_start: string | null;
    outcomes: { index: number; label: string; tokenId: string | null }[] | null;
  } | null;
  profiles: ProfileRow | null;
}

export async function loadFeed(opts: { scope: "all" | "following" | "profile"; viewerId?: string | null; profileId?: string; limit?: number; before?: string }): Promise<FeedItem[]> {
  const db = supabaseAdmin();
  let q = db
    .from("bets")
    .select(
      "id, profile_id, outcome, outcome_index, side, size, price, usdc, fee_usdc, builder_fee, status, pnl, tx_hash, matched_at, token_id, markets!bets_condition_id_fkey(question, event_title, event_slug, league, kind, line, game_start, outcomes), profiles!bets_profile_id_fkey!inner(id, handle, display_name, avatar, bio, is_verified, wallet, created_at)",
    )
    .eq("side", "BUY")
    .not("profile_id", "is", null)
    .eq("profiles.is_banned", false) // a banned author's picks leave the feed with them
    .order("matched_at", { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.before) q = q.lte("matched_at", opts.before); // inclusive: same-second fills are never skipped (the client drops repeats by id)
  if (opts.scope === "profile" && opts.profileId) q = q.eq("profile_id", opts.profileId);
  if (opts.scope === "following" && opts.viewerId) {
    const { data: f } = await db.from("follows").select("followee_id").eq("follower_id", opts.viewerId);
    const ids = (f ?? []).map((x) => x.followee_id as string);
    if (ids.length === 0) return [];
    q = q.in("profile_id", ids);
  }
  const { data: rows, error } = await q;
  if (error) console.error("[patoli] feed query failed", error.message);
  if (!rows?.length) return [];
  const bets = rows as unknown as BetRow[];
  const pids = [...new Set(bets.map((b) => b.profile_id!).filter(Boolean))];
  const { data: stats } = await db.from("profile_stats").select("*").in("profile_id", pids);
  const sm = new Map((stats ?? []).map((s) => [s.profile_id as string, s as StatsRow]));
  return bets.filter((b) => b.profiles).map((b) => toFeedItem(b, sm.get(b.profile_id!)));
}

/* ───────────────────────────── Arena battles in the feed ───────────────────────────── */

interface BattleRow {
  id: string;
  player_a: string;
  player_b: string;
  eoa_a: string;
  eoa_b: string;
  stake: number | string;
  status: string;
  score_a: number;
  score_b: number;
  winner_eoa: string | null;
  settle_tx: string | null;
  finished_at: string | null;
  created_at: string;
  pa: ProfileRow | null;
  pb: ProfileRow | null;
}

const BATTLE_COLS =
  "id, player_a, player_b, eoa_a, eoa_b, stake, status, score_a, score_b, winner_eoa, settle_tx, finished_at, created_at, pa:profiles!arena_matches_player_a_fkey!inner(id, handle, display_name, avatar, bio, is_verified, wallet, created_at), pb:profiles!arena_matches_player_b_fkey!inner(id, handle, display_name, avatar, bio, is_verified, wallet, created_at)";

/**
 * Finished Arena matches as feed items. Perspective = the winner (draw → player A), or the
 * given profile on their own page. Both players are shown: PvP is head-to-head by design
 * (the "no counterparties" rule is for pool-matched sports bets, not for Batalla).
 */
export async function loadBattles(opts: { scope: "all" | "following" | "profile"; viewerId?: string | null; profileId?: string; limit?: number; before?: string }): Promise<FeedItem[]> {
  const db = supabaseAdmin();
  let q = db
    .from("arena_matches")
    .select(BATTLE_COLS)
    .in("status", ["finished", "ready", "settled", "disputed"])
    .eq("pa.is_banned", false)
    .eq("pb.is_banned", false)
    .order("finished_at", { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.before) q = q.lte("finished_at", opts.before);
  if (opts.scope === "profile" && opts.profileId) q = q.or(`player_a.eq.${opts.profileId},player_b.eq.${opts.profileId}`);
  if (opts.scope === "following" && opts.viewerId) {
    const { data: f } = await db.from("follows").select("followee_id").eq("follower_id", opts.viewerId);
    const ids = (f ?? []).map((x) => x.followee_id as string);
    if (ids.length === 0) return [];
    q = q.or(`player_a.in.(${ids.join(",")}),player_b.in.(${ids.join(",")})`);
  }
  const { data: rows, error } = await q;
  if (error) console.error("[patoli] battles query failed", error.message);
  if (!rows?.length) return [];
  const battles = rows as unknown as BattleRow[];
  const pids = [...new Set(battles.flatMap((b) => [b.player_a, b.player_b]))];
  const { data: stats } = await db.from("profile_stats").select("*").in("profile_id", pids);
  const sm = new Map((stats ?? []).map((s) => [s.profile_id as string, s as StatsRow]));
  return battles
    .filter((b) => b.pa && b.pb)
    .map((b) => {
      const winnerIsA = !!b.winner_eoa && b.winner_eoa.toLowerCase() === b.eoa_a.toLowerCase();
      const winnerIsB = !!b.winner_eoa && b.winner_eoa.toLowerCase() === b.eoa_b.toLowerCase();
      // perspective
      let meIsA = winnerIsA || (!winnerIsA && !winnerIsB);
      if (opts.scope === "profile" && opts.profileId) meIsA = b.player_a === opts.profileId;
      const me = toProfile((meIsA ? b.pa : b.pb)!, sm.get(meIsA ? b.player_a : b.player_b));
      const them = toProfile((meIsA ? b.pb : b.pa)!, sm.get(meIsA ? b.player_b : b.player_a));
      const scoreMe = meIsA ? b.score_a : b.score_b;
      const scoreThem = meIsA ? b.score_b : b.score_a;
      const result: "won" | "lost" | "draw" = !b.winner_eoa ? "draw" : (meIsA ? winnerIsA : winnerIsB) ? "won" : "lost";
      const stake = Number(b.stake);
      return {
        id: `battle:${b.id}`,
        kind: "battle",
        user: { handle: me.handle, avatar: me.avatar, verified: me.verified, record: me.record, pnl: me.pnl },
        league: null,
        event: "✊ Batalla",
        eventSlug: null,
        selection: `${result === "draw" ? "Empate" : result === "won" ? "Ganó" : "Perdió"} ${scoreMe}-${scoreThem}`,
        market: "Batalla",
        odds: 2,
        stake,
        payout: stake * 2,
        status: result === "won" ? "won" : result === "lost" ? "lost" : "void",
        pnl: result === "won" ? stake : result === "lost" ? -stake : 0,
        placedAt: b.finished_at ?? b.created_at,
        kickoff: null,
        proof: b.settle_tx,
        fire: 0,
        tails: 0,
        fades: 0,
        battle: { opponent: { handle: them.handle, avatar: them.avatar }, scoreMe, scoreThem, result },
      } satisfies FeedItem;
    });
}

/** Bets + battles, newest first. */
export function mergeFeed(a: FeedItem[], b: FeedItem[], limit = 40): FeedItem[] {
  return [...a, ...b].sort((x, y) => y.placedAt.localeCompare(x.placedAt)).slice(0, limit);
}

/** The profile id behind a request's Bearer DID token, or null when anonymous/invalid. */
export async function resolveViewer(req: NextRequest): Promise<string | null> {
  if (!isMagicAdminConfigured()) return null;
  const id = await verifyDidToken(bearer(req));
  if (!id) return null;
  const { data } = await supabaseAdmin().from("profile_private").select("profile_id").eq("issuer", id.issuer).maybeSingle();
  return (data?.profile_id as string) ?? null;
}

/**
 * Live price for open picks whose game has started: the market moves to ~1 or ~0 the moment
 * a game ends, hours before Polymarket resolves — so the card can say "va ganando" right away.
 * One CLOB call per response; failures just leave the cards without a price.
 */
export async function attachLive(items: FeedItem[]): Promise<FeedItem[]> {
  const now = Date.now();
  const live = items.filter((i) => i.kind !== "battle" && i.status === "open" && i.tokenId && i.kickoff && Date.parse(i.kickoff) <= now);
  if (live.length === 0) return items;
  try {
    const r = await fetch(`${CLOB_API_URL}/midpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([...new Set(live.map((i) => i.tokenId))].map((token_id) => ({ token_id }))),
      cache: "no-store",
    });
    if (!r.ok) return items;
    const mids = (await r.json()) as Record<string, string>;
    for (const it of live) {
      const p = Number(mids[it.tokenId!]);
      if (Number.isFinite(p)) it.livePrice = p;
    }
  } catch {
    /* best effort */
  }
  return items;
}

/** 🔥 counts per item, plus whether the viewer is among them. Mutates and returns `items`. */
/** 🔥 + Súbaseee/Bájeseee counts (all three live in `reactions`, told apart by `kind`). */
export async function attachFire(items: FeedItem[], viewerId: string | null): Promise<FeedItem[]> {
  if (items.length === 0) return items;
  const { data } = await supabaseAdmin().from("reactions").select("bet_id, profile_id, kind").in("kind", ["fire", "tail", "fade"]).in("bet_id", items.map((i) => i.id));
  const count = new Map<string, number>();
  const mine = new Set<string>();
  for (const r of data ?? []) {
    const k = `${r.kind}:${r.bet_id}`;
    count.set(k, (count.get(k) ?? 0) + 1);
    if (viewerId && r.profile_id === viewerId) mine.add(k);
  }
  for (const it of items) {
    it.fire = count.get(`fire:${it.id}`) ?? 0;
    it.tails = count.get(`tail:${it.id}`) ?? 0;
    it.fades = count.get(`fade:${it.id}`) ?? 0;
    if (viewerId) {
      it.fired = mine.has(`fire:${it.id}`);
      it.tailed = mine.has(`tail:${it.id}`);
      it.faded = mine.has(`fade:${it.id}`);
    }
  }
  return items;
}

function toFeedItem(b: BetRow, s: StatsRow | undefined): FeedItem {
  const m = b.markets;
  const { base: kind, period, stat } = splitKind(m?.kind ?? "other");
  const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const ou = (o: string) => (/^(over|yes)$/i.test(o) ? "Más" : /^(under|no)$/i.test(o) ? "Menos" : o);
  let selection = b.outcome;
  if (kind === "spread" && m?.line != null) selection = `${b.outcome} ${fmtLine(b.outcome_index === 0 ? m.line : -m.line)}`;
  if (kind === "total" && m?.line != null) selection = `${/over/i.test(b.outcome) ? "Más" : /under/i.test(b.outcome) ? "Menos" : b.outcome} ${m.line}`;
  if (kind === "moneyline" && /^draw$/i.test(b.outcome)) selection = "Empate";
  // Soccer 1X2: each side is its own yes/no market ("Will CD Guadalajara win on 2026-10-20?")
  if (kind === "moneyline" && /^(yes|no)$/i.test(b.outcome) && m?.question) {
    const q = m.question;
    const team = /end in a draw/i.test(q) ? "Empate" : shortTeam((q.match(/^Will (.+?) win/i)?.[1] ?? q).trim());
    if (/^yes$/i.test(b.outcome)) selection = team;
    else {
      // NO on a 1X2 side = doble oportunidad: "the other team or draw", or "either team" when it is the draw market
      const teams = (m.event_title ?? "").split(/\s+vs\.?\s+/i).map((x) => shortTeam(x.trim()));
      const other = teams.length === 2 ? teams.find((x) => x !== team) : undefined;
      selection = team === "Empate" ? (teams.length === 2 ? `${teams[0]} o ${teams[1]}` : "Cualquiera gana") : `${other ?? "Rival"} o Empate`;
    }
  }
  if (kind === "btts") selection = /^yes$/i.test(b.outcome) ? "Ambos anotan · Sí" : "Ambos anotan · No";
  if (kind === "team_total" && m?.line != null) {
    // "Steelers Team Total: O/U 10.5" · "A vs. B: Chelsea FC O/U 0.5" · "Timberwolves 1H Team Total: O/U 56.5"
    const q = m.question.includes(": ") && /vs\.?/.test(m.question.split(": ")[0]) ? m.question.split(": ").slice(1).join(": ") : m.question;
    const team = shortTeam(q.replace(/\s*(1H|2H|1st Half|2nd Half)?\s*Team Total.*$/i, "").replace(/\s*(1st Half|2nd Half)?\s*O\/U.*$/i, "").trim());
    selection = `${ou(b.outcome)} ${m.line} · ${team}`;
  }
  if (kind === "prop" && m?.line != null) {
    const player = m.question.split(":")[0].trim();
    selection = `${player} · ${ou(b.outcome)} ${m.line} ${STAT_SHORT[stat ?? ""] ?? ""}`.trim();
  }
  if (kind === "yesno" && m?.question) {
    const q = /\?: /.test(m.question) ? m.question.split("?: ")[0] + "?" : m.question.includes(": ") ? m.question.split(": ").slice(1).join(": ") : m.question;
    const what = q.replace(/^Exact Margin:\s*/i, "Margen exacto: ").replace(/Will there be a run scored in the first inning\?/i, "¿Carrera en la 1ª entrada?").replace(/Will the game go to extra innings\?/i, "¿Entradas extra?").replace(/Team to Score First/i, "Primero en anotar").replace(/Odd\/Even Score/i, "Par / impar").replace(/Overtime\?/i, "¿Tiempo extra?").replace(/Race to (\d+) Points?/i, "Carrera a $1").replace(/Safety\?/i, "¿Safety?").replace(/\s*O\/U\s*[\d.]+$/i, "");
    const pick = /^yes$/i.test(b.outcome) ? "Sí" : /^no$/i.test(b.outcome) ? "No" : shortTeam(b.outcome);
    selection = `${what} · ${pick}`;
  }
  if (period && PERIOD_TEXT[period]) selection = `${selection} · ${PERIOD_TEXT[period]}`;
  const p = b.profiles!;
  const prof = toProfile(p, s);
  return {
    id: b.id,
    user: { handle: prof.handle, avatar: prof.avatar, verified: prof.verified, record: prof.record, pnl: prof.pnl },
    league: m?.league ?? null,
    event: m?.event_title ?? m?.question ?? "Mercado",
    eventSlug: m?.event_slug ?? null,
    selection,
    market: MARKET_LABEL[kind] ?? "Otro",
    // What left the wallet (shares + fees; Polymarket's fee already includes ours) → effective odds = payout / that.
    odds: paidOf(b) > 0 ? Number(b.size) / paidOf(b) : 0,
    stake: paidOf(b),
    payout: Number(b.size),
    status: b.status,
    pnl: b.pnl == null ? null : Number(b.pnl),
    placedAt: b.matched_at,
    kickoff: m?.game_start ?? null,
    tokenId: b.token_id,
    // Every Polymarket market has exactly two tokens; the one we did not buy is the fade.
    fadeTokenId: m?.outcomes?.length === 2 ? (m.outcomes.find((o) => o.tokenId && o.tokenId !== b.token_id)?.tokenId ?? undefined) : undefined,
    proof: b.tx_hash,
    fire: 0,
    tails: 0,
    fades: 0,
    kind: "bet",
  };
}
