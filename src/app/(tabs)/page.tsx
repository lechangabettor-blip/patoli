import type { Metadata } from "next";
import HomeFeed from "@/components/HomeFeed";

export const metadata: Metadata = { title: "Inicio" };

export default function HomePage() {
  return <HomeFeed />;
}
