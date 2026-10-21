import "server-only";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";
import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { shortTeam } from "@/lib/polymarket/gamma";
import type { FeedItem, PublicProfile } from "@/types/social";

/** Read models for profiles and the feed. Server-only. */

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
  const { data: s } = await db.from("profile_stats").select("*").eq("profile_id", p.id).maybeSingle<StatsRow>();
  const battleStats = attachBattleStats; // (applied below once the profile object exists)
  const profile = toProfile(p, s ?? undefined);
  await battleStats([profile]);
  if (viewerId) {
    profile.isMe = viewerId === p.id;
    if (!profile.isMe) {
      const { data: f } = await db.from("follows").select("follower_id").eq("follower_id", viewerId).eq("followee_id", p.id).maybeSingle();
      profile.isFollowing = !!f;
    }
  }
  return profile;
}

export async function searchProfiles(q: string, limit = 20): Promise<PublicProfile[]> {
  const db = supabaseAdmin();
  const needle = q.toLowerCase().replace(/[^a-z0-9_ ]/g, "");
  let query = db.from("profiles").select("id, handle, display_name, avatar, bio, is_verified, wallet, created_at").eq("is_banned", false).limit(limit);
  query = needle ? query.or(`handle.ilike.%${needle}%,display_name.ilike.%${needle}%`) : query.order("created_at", { ascending: false });
  const { data: rows } = await query;
  if (!rows?.length) return [];
  const { data: stats } = await db.from("profile_stats").select("*").in("profile_id", rows.map((r) => r.id));
  const sm = new Map((stats ?? []).map((s) => [s.profile_id as string, s as StatsRow]));
  const out = (rows as ProfileRow[]).map((r) => toProfile(r, sm.get(r.id)));
  await attachBattleStats(out);
  return out;
}

const MARKET_LABEL: Record<string, FeedItem["market"]> = { moneyline: "ML", spread: "Spread", total: "Total", btts: "BTTS" };

interface BetRow {
  id: string;
  profile_id: string | null;
  outcome: string;
  outcome_index: number;
  side: string;
  size: number;
  price: number;
  usdc: number;
  status: FeedItem["status"];
  pnl: number | null;
  tx_hash: string | null;
  matched_at: string;
  markets: { question: string; event_title: string | null; event_slug: string | null; league: string | null; kind: string | null; line: number | null; game_start: string | null } | null;
  profiles: ProfileRow | null;
}

export async function loadFeed(opts: { scope: "all" | "following" | "profile"; viewerId?: string | null; profileId?: string; limit?: number; before?: string }): Promise<FeedItem[]> {
  const db = supabaseAdmin();
  let q = db
    .from("bets")
    .select(
      "id, profile_id, outcome, outcome_index, side, size, price, usdc, status, pnl, tx_hash, matched_at, markets!bets_condition_id_fkey(question, event_title, event_slug, league, kind, line, game_start), profiles!bets_profile_id_fkey(id, handle, display_name, avatar, bio, is_verified, wallet, created_at)",
    )
    .eq("side", "BUY")
    .not("profile_id", "is", null)
    .order("matched_at", { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.before) q = q.lt("matched_at", opts.before);
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
  "id, player_a, player_b, eoa_a, eoa_b, stake, status, score_a, score_b, winner_eoa, settle_tx, finished_at, created_at, pa:profiles!arena_matches_player_a_fkey(id, handle, display_name, avatar, bio, is_verified, wallet, created_at), pb:profiles!arena_matches_player_b_fkey(id, handle, display_name, avatar, bio, is_verified, wallet, created_at)";

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
    .order("finished_at", { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.before) q = q.lt("finished_at", opts.before);
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
        event: "Batalla · piedra, papel o tijera",
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

/** 🔥 counts per item, plus whether the viewer is among them. Mutates and returns `items`. */
export async function attachFire(items: FeedItem[], viewerId: string | null): Promise<FeedItem[]> {
  if (items.length === 0) return items;
  const { data } = await supabaseAdmin().from("reactions").select("bet_id, profile_id").eq("kind", "fire").in("bet_id", items.map((i) => i.id));
  const count = new Map<string, number>();
  const mine = new Set<string>();
  for (const r of data ?? []) {
    count.set(r.bet_id as string, (count.get(r.bet_id as string) ?? 0) + 1);
    if (viewerId && r.profile_id === viewerId) mine.add(r.bet_id as string);
  }
  for (const it of items) {
    it.fire = count.get(it.id) ?? 0;
    if (viewerId) it.fired = mine.has(it.id);
  }
  return items;
}

function toFeedItem(b: BetRow, s: StatsRow | undefined): FeedItem {
  const m = b.markets;
  const kind = m?.kind ?? "other";
  const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  let selection = b.outcome;
  if (kind === "spread" && m?.line != null) selection = `${b.outcome} ${fmtLine(b.outcome_index === 0 ? m.line : -m.line)}`;
  if (kind === "total" && m?.line != null) selection = `${/over/i.test(b.outcome) ? "Más" : /under/i.test(b.outcome) ? "Menos" : b.outcome} ${m.line}`;
  if (kind === "moneyline" && /^draw$/i.test(b.outcome)) selection = "Empate";
  // Soccer 1X2: each side is its own yes/no market ("Will CD Guadalajara win on 2026-10-20?")
  if (kind === "moneyline" && /^(yes|no)$/i.test(b.outcome) && m?.question) {
    const q = m.question;
    const team = /end in a draw/i.test(q) ? "Empate" : shortTeam((q.match(/^Will (.+?) win/i)?.[1] ?? q).trim());
    selection = /^yes$/i.test(b.outcome) ? team : `No ${team}`;
  }
  if (kind === "btts") selection = /^yes$/i.test(b.outcome) ? "Ambos anotan · Sí" : "Ambos anotan · No";
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
    odds: Number(b.price) > 0 ? 1 / Number(b.price) : 0,
    stake: Number(b.usdc),
    payout: Number(b.size),
    status: b.status,
    pnl: b.pnl == null ? null : Number(b.pnl),
    placedAt: b.matched_at,
    kickoff: m?.game_start ?? null,
    proof: b.tx_hash,
    fire: 0,
    kind: "bet",
  };
}
