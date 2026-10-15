import { DEMO_BETS, DEMO_USERS, findUser } from "@/data/demo";
import type { FeedItem, PublicProfile } from "@/types/social";

/** Demo content shaped like the real API, used until Supabase is configured. */

export function demoProfile(handle: string): PublicProfile | null {
  const u = findUser(handle);
  if (!u) return null;
  return {
    id: `demo-${u.handle}`,
    handle: u.handle,
    displayName: u.name,
    avatar: u.avatar,
    bio: u.bio ?? null,
    verified: !!u.verified,
    wallet: "0x0000000000000000000000000000000000000000",
    record: { w: u.record.w, l: u.record.l, v: u.record.v, open: 1 },
    pnl: u.units * 10,
    staked: (u.record.w + u.record.l) * 10,
    roi: u.roi,
    followers: u.followers,
    following: u.following,
    createdAt: new Date(0).toISOString(),
  };
}

export function demoProfiles(): PublicProfile[] {
  return DEMO_USERS.map((u) => demoProfile(u.handle)!).filter(Boolean);
}

export function demoFeed(scope: "all" | "following" | "profile", handle?: string): FeedItem[] {
  const bets = scope === "profile" ? DEMO_BETS.filter((b) => b.user === handle) : scope === "following" ? DEMO_BETS.filter((b) => ["lechanga", "paulovski"].includes(b.user)) : DEMO_BETS;
  return bets
    .map((b) => {
      const p = demoProfile(b.user);
      if (!p) return null;
      const item: FeedItem = {
        id: b.id,
        user: { handle: p.handle, avatar: p.avatar, verified: p.verified, record: p.record, pnl: p.pnl },
        league: b.league,
        event: b.event,
        eventSlug: null,
        selection: b.selection,
        market: b.market,
        odds: b.odds,
        stake: b.stake,
        payout: b.stake * b.odds,
        status: b.status,
        pnl: b.status === "won" ? b.stake * (b.odds - 1) : b.status === "lost" ? -b.stake : null,
        placedAt: b.placedAt,
        kickoff: null,
        proof: null,
        fire: b.fire,
      };
      return item;
    })
    .filter((x): x is FeedItem => !!x);
}
