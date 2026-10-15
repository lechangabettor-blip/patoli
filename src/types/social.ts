/** Shapes shared between API routes and the UI. */

export type BetStatus = "open" | "won" | "lost" | "void";

export interface PublicProfile {
  id: string;
  handle: string;
  displayName: string | null;
  avatar: string; // emoji or seed
  bio: string | null;
  verified: boolean;
  wallet: string;
  record: { w: number; l: number; v: number; open: number };
  pnl: number;
  staked: number;
  roi: number; // %
  followers: number;
  following: number;
  createdAt: string;
  /** Only present when a viewer is known */
  isFollowing?: boolean;
  isMe?: boolean;
}

export interface FeedItem {
  id: string;
  user: Pick<PublicProfile, "handle" | "avatar" | "verified" | "record" | "pnl">;
  league: string | null; // LeagueId or null
  event: string; // "Seahawks vs. Broncos"
  eventSlug: string | null;
  selection: string; // "Seahawks -2.5"
  market: "ML" | "Spread" | "Total" | "Otro";
  odds: number; // gross decimal at fill (1/price)
  stake: number; // USDC
  payout: number; // shares = USDC if wins
  status: BetStatus;
  pnl: number | null;
  placedAt: string; // ISO
  kickoff: string | null;
  proof: string | null; // tx hash
  fire: number;
}

export interface MeProfile extends PublicProfile {
  email: string | null;
}
