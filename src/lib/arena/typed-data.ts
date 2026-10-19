import { encodePacked, keccak256, type Hex } from "viem";

/**
 * EIP-712 definitions shared by the browser (signing) and the server
 * (verification + settlement). Must match contracts/PatoliArena.sol exactly.
 */

export const ARENA_ADDRESS = (process.env.NEXT_PUBLIC_ARENA_ADDRESS ?? "") as Hex;
export const ARENA_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARENA_CHAIN_ID ?? 137);
export const isArenaConfigured = () => /^0x[0-9a-fA-F]{40}$/.test(ARENA_ADDRESS);

export const ARENA_DOMAIN = {
  name: "PatoliArena",
  version: "1",
  chainId: ARENA_CHAIN_ID,
  verifyingContract: ARENA_ADDRESS,
} as const;

export const ARENA_TYPES = {
  Match: [
    { name: "id", type: "bytes32" },
    { name: "playerA", type: "address" },
    { name: "playerB", type: "address" },
    { name: "stake", type: "uint256" },
    { name: "bestOf", type: "uint8" },
    { name: "deadline", type: "uint64" },
  ],
  Commit: [
    { name: "matchId", type: "bytes32" },
    { name: "round", type: "uint8" },
    { name: "hash", type: "bytes32" },
  ],
  CommitAck: [
    { name: "matchId", type: "bytes32" },
    { name: "round", type: "uint8" },
    { name: "player", type: "address" },
    { name: "hash", type: "bytes32" },
  ],
  RevealAck: [
    { name: "matchId", type: "bytes32" },
    { name: "round", type: "uint8" },
    { name: "player", type: "address" },
    { name: "move", type: "uint8" },
    { name: "salt", type: "bytes32" },
  ],
  Withdraw: [
    { name: "player", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface MatchStruct {
  id: Hex;
  playerA: Hex;
  playerB: Hex;
  stake: bigint; // 6 decimals
  bestOf: number;
  deadline: bigint; // unix seconds
}

export type Move = 1 | 2 | 3; // piedra · papel · tijera
export const MOVE_LABEL: Record<Move, { label: string; emoji: string }> = {
  1: { label: "Piedra", emoji: "✊" },
  2: { label: "Papel", emoji: "✋" },
  3: { label: "Tijera", emoji: "✌️" },
};

/** keccak256(abi.encodePacked(matchId, round, player, move, salt)) — same as the contract. */
export function commitHash(matchId: Hex, round: number, player: Hex, move: Move, salt: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "uint8", "address", "uint8", "bytes32"], [matchId, round, player, move, salt]));
}

export function beats(a: Move, b: Move): boolean {
  return (a === 1 && b === 3) || (a === 2 && b === 1) || (a === 3 && b === 2);
}

/** USD number ↔ 6-decimal token units */
export const toUnits = (usd: number) => BigInt(Math.round(usd * 1e6));
export const fromUnits = (u: bigint) => Number(u) / 1e6;

/** DB row shape (public columns) → MatchStruct for signing/verification */
export function toMatchStruct(row: { id: string; eoa_a: string; eoa_b: string; stake: number | string; best_of: number; deadline: string }): MatchStruct {
  return {
    id: row.id as Hex,
    playerA: row.eoa_a as Hex,
    playerB: row.eoa_b as Hex,
    stake: toUnits(Number(row.stake)),
    bestOf: row.best_of,
    deadline: BigInt(Math.floor(new Date(row.deadline).getTime() / 1000)),
  };
}

// Match protocol timing (server-enforced, mirrored in the UI)
export const COMMIT_SECONDS = 15;
export const REVEAL_SECONDS = 15;
export const SIGN_SECONDS = 20;
export const MATCH_TTL_MINUTES = 10; // Match.deadline = created + TTL; dispute opens after
export const LOBBY_STAKE_USD = 1;
export const BEST_OF = 3;
