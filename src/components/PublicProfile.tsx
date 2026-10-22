"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Avatar from "./Avatar";
import HistoryTabs from "./HistoryTabs";
import BottomNav from "./BottomNav";
import Sheet from "./Sheet";
import TicketShare from "./TicketShare";
import type { TicketData } from "./Ticket";
import { useUser, ticketFromItem } from "@/hooks/useSocial";
import { useMe } from "@/providers/MeProvider";
import { useWallet } from "@/providers/WalletContext";
import { POLYMARKET_PROFILE_URL } from "@/lib/polymarket/constants";
import StatsWindows from "./StatsWindows";

export default function PublicProfile({ handle }: { handle: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useWallet();
  const { me, follow } = useMe();
  const q = useUser(handle);
  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggleFollow(want: boolean) {
    if (status !== "connected") {
      router.push(`/entrar?next=/u/${handle}`);
      return;
    }
    setBusy(true);
    const ok = await follow(handle, want);
    setBusy(false);
    if (ok) qc.invalidateQueries({ queryKey: ["user", handle] });
  }

  const p = q.data?.profile;
  const bets = q.data?.bets ?? [];
  const isMe = !!p && (p.isMe || me?.handle === p.handle);

  return (
    <>
      <main className="mx-auto min-h-dvh max-w-md px-4 pb-28 pt-4">
        <Link href="/" className="btn-ghost inline-flex items-center gap-1 px-3 py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Inicio
        </Link>

        {q.isLoading ? (
          <div className="mt-4 space-y-3">
            <div className="skeleton h-56" />
            <div className="skeleton h-40" />
          </div>
        ) : !p ? (
          <div className="card mt-4 p-6 text-center">
            <div className="text-5xl">🫥</div>
            <h1 className="mt-3 text-2xl normal-case tracking-normal">@{handle} no existe</h1>
            <p className="mt-2 text-sm text-muted">Revisa el nombre o busca a la banda.</p>
            <Link href="/buscar" className="btn-accent mt-4 inline-block px-5 py-2.5 text-xs">
              Buscar
            </Link>
          </div>
        ) : (
          <>
            <section className="card mt-4 overflow-hidden">
              <div className="h-20 bg-[radial-gradient(80%_120%_at_20%_0%,rgba(255,61,23,.45),transparent_70%)]" />
              <div className="-mt-9 px-4 pb-4">
                <div className="flex items-end justify-between">
                  <span className="rounded-full border-4 border-bg">
                    <Avatar seed={p.avatar} size={72} />
                  </span>
                  {isMe ? (
                    <Link href="/perfil" className="btn-ghost px-4 py-2 font-display text-xs font-bold uppercase">
                      Mi cuenta
                    </Link>
                  ) : p.isFollowing ? (
                    <button onClick={() => toggleFollow(false)} disabled={busy} className="btn-ghost px-5 py-2 font-display text-xs font-bold uppercase">
                      Siguiendo
                    </button>
                  ) : (
                    <button onClick={() => toggleFollow(true)} disabled={busy} className="btn-accent px-5 py-2 text-xs">
                      Seguir
                    </button>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <h1 className="text-2xl normal-case tracking-normal">@{p.handle}</h1>
                  {p.verified ? <span className="text-accent">✦</span> : null}
                </div>
                {p.bio ? <p className="mt-1 text-sm text-muted">{p.bio}</p> : null}
                <div className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    <b className="text-ink">{p.followers.toLocaleString("es-MX")}</b> seguidores
                  </span>
                  <span>
                    <b className="text-ink">{p.following}</b> siguiendo
                  </span>
                  {p.battles.w + p.battles.l + p.battles.d > 0 ? (
                    <span>
                      ✊ Batallas <b className="text-ink">{p.battles.w}-{p.battles.l}{p.battles.d ? `-${p.battles.d}` : ""}</b>
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="border-t border-hairline px-3 pb-3 pt-3">
                <StatsWindows profile={p} />
              </div>
            </section>

            <HistoryTabs items={bets} onTicket={(it) => setTicket(ticketFromItem(it))} />
            {!q.data?.demo ? (
              <a href={POLYMARKET_PROFILE_URL(p.wallet)} target="_blank" rel="noreferrer" className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
                Verificar historial on-chain <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Perfil de ejemplo. Los récords reales salen de la blockchain.</p>
            )}
          </>
        )}
      </main>
      <BottomNav />
      <Sheet open={!!ticket} onClose={() => setTicket(null)} title="Boleto">
        {ticket ? <TicketShare data={ticket} onDone={() => setTicket(null)} /> : null}
      </Sheet>
    </>
  );
}

