import type { Metadata } from "next";
import BattleLobby from "@/components/BattleLobby";

export const metadata: Metadata = { title: "Batalla" };

export default function BattlePage() {
  return <BattleLobby />;
}
