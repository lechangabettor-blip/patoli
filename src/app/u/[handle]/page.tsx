import type { Metadata } from "next";
import { Suspense } from "react";
import PublicProfile from "@/components/PublicProfile";

export async function generateMetadata({ params }: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  return { title: `@${handle}`, description: `Récord y picks de @${handle} en Patoli, verificables on-chain.` };
}

export default function PublicProfilePage({ params }: PageProps<"/u/[handle]">) {
  return (
    <Suspense fallback={null}>
      <Loader params={params} />
    </Suspense>
  );
}

async function Loader({ params }: { params: PageProps<"/u/[handle]">["params"] }) {
  const { handle } = await params;
  return <PublicProfile handle={handle.toLowerCase()} />;
}
