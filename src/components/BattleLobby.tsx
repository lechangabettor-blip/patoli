"use client";

import BattleArena from "./BattleArena";
import BattleLobbyDemo from "./BattleLobbyDemo";
import { isArenaConfigured } from "@/lib/arena/typed-data";

/**
 * Batalla tab. Real Arena (contract + signed matches) when the contract address
 * is configured; otherwise the clearly-labelled demo with a simulated rival.
 */
export default function BattleLobby() {
  return isArenaConfigured() ? <BattleArena /> : <BattleLobbyDemo />;
}
