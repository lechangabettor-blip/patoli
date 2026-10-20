import type { Metadata } from "next";
import BattleArena from "@/components/BattleArena";

export const metadata: Metadata = { title: "Batalla" };

export default function BattlePage() {
  return <BattleArena />;
}
