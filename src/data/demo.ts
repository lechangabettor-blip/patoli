/**
 * DEMO DATA — placeholder content for the pre-launch UI.
 * Replaced by Supabase + on-chain indexer rows in Phase 2. Every item here is
 * clearly fictional (handles end in "_demo") so it can never be mistaken for
 * a real record.
 */
import type { LeagueId } from "@/lib/polymarket/leagues";

export type BetStatus = "open" | "won" | "lost" | "void";

export interface DemoUser {
  handle: string;
  name: string;
  avatar: string; // emoji seed
  record: { w: number; l: number; v: number };
  units: number;
  roi: number; // %
  followers: number;
  following: number;
  streak: number;
  verified?: boolean;
  bio?: string;
}

export interface DemoBet {
  id: string;
  user: string; // handle
  league: LeagueId;
  event: string;
  selection: string;
  market: "ML" | "Spread" | "Total";
  odds: number;
  stake: number;
  status: BetStatus;
  placedAt: string;
  fire: number;
  proof?: string;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const DEMO_USERS: DemoUser[] = [
  { handle: "lechanga", name: "LeChanga", avatar: "🦧", record: { w: 212, l: 188, v: 9 }, units: 41.2, roi: 10.1, followers: 4362, following: 31, streak: 3, verified: true, bio: "Cualquiera opina. Nosotros apostamos. SUBASEEE 🦧" },
  { handle: "paulovski", name: "Paulovski", avatar: "🐺", record: { w: 97, l: 84, v: 3 }, units: 12.4, roi: 6.7, followers: 1820, following: 44, streak: -2, verified: true },
  { handle: "skilz_demo", name: "Skilz", avatar: "🎯", record: { w: 58, l: 41, v: 2 }, units: 19.8, roi: 19.6, followers: 312, following: 12, streak: 5 },
  { handle: "wasat_demo", name: "Wasatnight", avatar: "🌙", record: { w: 44, l: 52, v: 1 }, units: -6.1, roi: -6.3, followers: 96, following: 58, streak: -1 },
  { handle: "funguis_demo", name: "Funguis", avatar: "🍄", record: { w: 31, l: 22, v: 0 }, units: 11.3, roi: 21.3, followers: 140, following: 20, streak: 2 },
  { handle: "ansess_demo", name: "Ansess", avatar: "⚡", record: { w: 70, l: 71, v: 4 }, units: 2.2, roi: 1.5, followers: 230, following: 75, streak: 1 },
];

export const DEMO_BETS: DemoBet[] = [
  { id: "b1", user: "lechanga", league: "ligamx", event: "América vs. Chivas", selection: "América ML", market: "ML", odds: 2.08, stake: 50, status: "open", placedAt: minutesAgo(12), fire: 48 },
  { id: "b2", user: "skilz_demo", league: "nfl", event: "Cowboys vs. Packers", selection: "Packers -3.5", market: "Spread", odds: 1.95, stake: 25, status: "open", placedAt: minutesAgo(38), fire: 17 },
  { id: "b3", user: "paulovski", league: "nba", event: "Lakers vs. Warriors", selection: "Más de 228.5", market: "Total", odds: 1.91, stake: 40, status: "won", placedAt: minutesAgo(190), fire: 33 },
  { id: "b4", user: "funguis_demo", league: "ucl", event: "Real Madrid vs. Arsenal", selection: "Empate", market: "ML", odds: 3.6, stake: 10, status: "open", placedAt: minutesAgo(240), fire: 9 },
  { id: "b5", user: "wasat_demo", league: "epl", event: "Liverpool vs. Man City", selection: "Liverpool ML", market: "ML", odds: 2.45, stake: 20, status: "lost", placedAt: minutesAgo(600), fire: 4 },
  { id: "b6", user: "ansess_demo", league: "laliga", event: "Barcelona vs. Sevilla", selection: "Menos de 2.5", market: "Total", odds: 2.2, stake: 15, status: "won", placedAt: minutesAgo(900), fire: 12 },
  { id: "b7", user: "lechanga", league: "nfl", event: "Chiefs vs. Bills", selection: "Chiefs ML", market: "ML", odds: 1.78, stake: 100, status: "won", placedAt: minutesAgo(1500), fire: 91 },
];

export const findUser = (handle: string) => DEMO_USERS.find((u) => u.handle === handle);
