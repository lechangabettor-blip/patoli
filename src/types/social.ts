/** Shapes shared between API routes and the UI. */

type BetStatus = "open" | "won" | "lost" | "void";

export type WindowKey = "d7" | "d30" | "all";

/** One rolling window of results. Sports and Batalla are separate records. */
export interface StatsWindow {
  sports: { w: number; l: number; v: number; units: number; pnl: number; staked: number; roi: number };
  battles: { w: number; l: number; d: number; pnl: number };
}

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
  /** Unidades: Σ won (odds−1) − lost, stake-independent (Challenge rule) */
  units: number;
  followers: number;
  following: number;
  /** Arena (piedra·papel·tijera) record */
  battles: { w: number; l: number; d: number; pnl: number };
  /** Unidades settled in the last 7 days (rolling) — the people rail sorts by this */
  units7?: number;
  /** Sports picks settled in the last 7 days — the rail shows everyone with at least one */
  settled7?: number;
  /** Rolling windows by settlement time (single-profile loads only) */
  windows?: Record<WindowKey, StatsWindow>;
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
  market: "ML" | "Spread" | "Total" | "BTTS" | "Prop" | "Batalla" | "Otro";
  odds: number; // gross decimal at fill (1/price)
  stake: number; // USDC
  payout: number; // shares = USDC if wins
  status: BetStatus;
  pnl: number | null;
  placedAt: string; // ISO
  kickoff: string | null;
  /** Outcome token (sports bets) — lets the server attach a live price */
  tokenId?: string;
  /** The other token of the same Polymarket market (what "Bájeseee" buys) */
  fadeTokenId?: string;
  /** Current market price of the pick (0–1) while open and the game has started */
  livePrice?: number;
  proof: string | null; // tx hash
  fire: number;
  /** The viewer already reacted (only when a viewer is known) */
  fired?: boolean;
  /** People who placed the same bet from this card (Súbaseee) / the opposite side (Bájeseee) */
  tails: number;
  fades: number;
  tailed?: boolean;
  faded?: boolean;
  /** "battle" items come from the Arena; everything else is a Polymarket bet */
  kind?: "bet" | "battle";
  battle?: {
    opponent: { handle: string; avatar: string };
    scoreMe: number;
    scoreThem: number;
    result: "won" | "lost" | "draw";
  };
}

/** One money movement of the owner's deposit wallet (Dinero tab; private) */
export interface MoneyRow {
  hash: string;
  at: string; // ISO
  kind: "deposit" | "withdraw" | "tip_in" | "tip_out" | "arena_in" | "arena_out" | "send";
  /** Signed: + into the wallet, − out of it */
  amount: number;
  asset: "pUSD" | "USDC";
  /** The other user, for tips */
  handle?: string;
}

export interface MeProfile extends PublicProfile {
  email: string | null;
  /** pUSD received as tips, all time (private: only the owner sees it) */
  tipsReceived?: number;
}
