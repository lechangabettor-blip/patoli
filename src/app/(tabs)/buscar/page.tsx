import type { Metadata } from "next";
import SearchScreen from "@/components/SearchScreen";

export const metadata: Metadata = { title: "Buscar" };

export default function SearchPage() {
  return <SearchScreen />;
}
