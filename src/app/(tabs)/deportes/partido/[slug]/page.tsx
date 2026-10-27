import type { Metadata } from "next";
import { Suspense } from "react";
import GameDetailScreen from "@/components/GameDetailScreen";

export const metadata: Metadata = { title: "Partido" };

export default function GamePage({ params }: PageProps<"/deportes/partido/[slug]">) {
  return (
    <Suspense fallback={null}>
      <Loader params={params} />
    </Suspense>
  );
}

async function Loader({ params }: { params: PageProps<"/deportes/partido/[slug]">["params"] }) {
  const { slug } = await params;
  return <GameDetailScreen slug={slug.toLowerCase()} />;
}
