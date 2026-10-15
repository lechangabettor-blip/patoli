import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Avatar from "@/components/Avatar";
import FeedCard from "@/components/FeedCard";
import BottomNav from "@/components/BottomNav";
import { DEMO_BETS, findUser } from "@/data/demo";

export async function generateMetadata({ params }: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  return { title: `@${handle}` };
}

/** Public profile. Demo data until the indexer ships (Phase 2). */
export default async function PublicProfilePage({ params }: PageProps<"/u/[handle]">) {
  const { handle } = await params;
  const user = findUser(handle);
  if (!user) notFound();
  const bets = DEMO_BETS.filter((b) => b.user === user.handle);
  const total = user.record.w + user.record.l;
  const winPct = total ? Math.round((user.record.w / total) * 100) : 0;

  return (
    <>
      <main className="mx-auto min-h-dvh max-w-md px-4 pb-28 pt-4">
        <Link href="/" className="btn-ghost inline-flex items-center gap-1 px-3 py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Inicio
        </Link>

        <section className="card mt-4 overflow-hidden">
          <div className="h-20 bg-[radial-gradient(80%_120%_at_20%_0%,rgba(255,61,23,.45),transparent_70%)]" />
          <div className="-mt-9 px-4 pb-4">
            <div className="flex items-end justify-between">
              <span className="rounded-full border-4 border-bg">
                <Avatar seed={user.avatar} size={72} />
              </span>
              <button className="btn-accent px-5 py-2 text-xs">Seguir</button>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <h1 className="text-2xl normal-case tracking-normal">@{user.handle}</h1>
              {user.verified ? <span className="text-accent">✦</span> : null}
            </div>
            {user.bio ? <p className="mt-1 text-sm text-muted">{user.bio}</p> : null}
            <div className="tnum mt-2 flex gap-4 text-xs text-muted">
              <span>
                <b className="text-ink">{user.followers.toLocaleString("es-MX")}</b> seguidores
              </span>
              <span>
                <b className="text-ink">{user.following}</b> siguiendo
              </span>
            </div>
          </div>
          <div className="grid grid-cols-4 border-t border-hairline">
            <Stat k="Récord" v={`${user.record.w}-${user.record.l}`} />
            <Stat k="Acierto" v={`${winPct}%`} />
            <Stat k="Unidades" v={`${user.units >= 0 ? "+" : ""}${user.units.toFixed(1)}`} cls={user.units >= 0 ? "text-win" : "text-loss"} />
            <Stat k="ROI" v={`${user.roi >= 0 ? "+" : ""}${user.roi.toFixed(1)}%`} cls={user.roi >= 0 ? "text-win" : "text-loss"} />
          </div>
        </section>

        <h2 className="mt-6 text-lg">Historial</h2>
        <div className="mt-2 space-y-3">
          {bets.map((b, i) => (
            <FeedCard key={b.id} bet={b} user={user} index={i} />
          ))}
          {bets.length === 0 ? <p className="card p-4 text-center text-sm text-muted">Sin apuestas todavía.</p> : null}
        </div>
        <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Perfil de ejemplo. Los récords reales salen de la blockchain.</p>
      </main>
      <BottomNav />
    </>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="px-2 py-3 text-center">
      <div className={`tnum font-display text-base font-extrabold ${cls ?? ""}`}>{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
    </div>
  );
}
