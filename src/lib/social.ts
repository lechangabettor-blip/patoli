import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
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
    followers: Number(s?.followers ?? 0),
    following: Number(s?.following ?? 0),
    createdAt: p.created_at,
  };
}

export async function loadProfile(by: { id?: string; handle?: string }, viewerId?: string | null): Promise<PublicProfile | null> {
  const db = supabaseAdmin();
  let q = db.from("profiles").select("id, handle, display_name, avatar, bio, is_verified, wallet, created_at").eq("is_banned", false);
  q = by.id ? q.eq("id", by.id) : q.eq("handle", (by.handle ?? "").toLowerCase());
  const { data: p } = await q.maybeSingle<ProfileRow>();
  if (!p) return null;
  const { data: s } = await db.from("profile_stats").select("*").eq("profile_id", p.id).maybeSingle<StatsRow>();
  const profile = toProfile(p, s ?? undefined);
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
  return (rows as ProfileRow[]).map((r) => toProfile(r, sm.get(r.id)));
}

const MARKET_LABEL: Record<string, FeedItem["market"]> = { moneyline: "ML", spread: "Spread", total: "Total" };

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
      "id, profile_id, outcome, outcome_index, side, size, price, usdc, status, pnl, tx_hash, matched_at, markets(question, event_title, event_slug, league, kind, line, game_start), profiles(id, handle, display_name, avatar, bio, is_verified, wallet, created_at)",
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
  const { data: rows } = await q;
  if (!rows?.length) return [];
  const bets = rows as unknown as BetRow[];
  const pids = [...new Set(bets.map((b) => b.profile_id!).filter(Boolean))];
  const { data: stats } = await db.from("profile_stats").select("*").in("profile_id", pids);
  const sm = new Map((stats ?? []).map((s) => [s.profile_id as string, s as StatsRow]));
  return bets.filter((b) => b.profiles).map((b) => toFeedItem(b, sm.get(b.profile_id!)));
}

function toFeedItem(b: BetRow, s: StatsRow | undefined): FeedItem {
  const m = b.markets;
  const kind = m?.kind ?? "other";
  const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  let selection = b.outcome;
  if (kind === "spread" && m?.line != null) selection = `${b.outcome} ${fmtLine(b.outcome_index === 0 ? m.line : -m.line)}`;
  if (kind === "total" && m?.line != null) selection = `${/over/i.test(b.outcome) ? "Más" : /under/i.test(b.outcome) ? "Menos" : b.outcome} ${m.line}`;
  if (kind === "moneyline" && /^draw$/i.test(b.outcome)) selection = "Empate";
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
  };
}
