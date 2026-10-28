"use client";

import { useState } from "react";
import Link from "next/link";
import TopBar from "./TopBar";
import FeedCard from "./FeedCard";
import Sheet from "./Sheet";
import TicketShare from "./TicketShare";
import type { TicketData } from "./Ticket";
import { useFeed, useUsers, ticketFromItem } from "@/hooks/useSocial";
import { useWallet } from "@/providers/WalletContext";
import { cn } from "@/lib/cn";

type Tab = "all" | "following";

export default function HomeFeed() {
  const [tab, setTab] = useState<Tab>("all");
  const [ticket, setTicket] = useState<TicketData | null>(null);
  const { status } = useWallet();
  const feed = useFeed(tab);
  const people = useUsers("", "rail");

  return (
    <>
      <TopBar
        right={
          <div className="flex rounded-full bg-surface p-0.5">
            {(["all", "following"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-3 py-1 font-display text-[10px] font-bold uppercase tracking-wide transition-colors",
                  tab === t ? "bg-accent text-white" : "text-muted",
                )}
              >
                {t === "all" ? "Todos" : "Siguiendo"}
              </button>
            ))}
          </div>
        }
      />

      {/* People rail */}
      <section className="no-scrollbar flex gap-3 overflow-x-auto px-4 pt-4">
        {(people.data?.items ?? []).map((u, i) => (
          <Link key={u.handle} href={`/u/${u.handle}`} className="rise flex w-16 shrink-0 flex-col items-center gap-1.5" style={{ animationDelay: `${i * 40}ms` }}>
            {/* Ring = this person has a pick riding right now (open or not yet settled). LeChanga, 2026-10-22. */}
            <span className={cn("rounded-full p-[2px]", u.record.open > 0 ? "bg-[conic-gradient(var(--accent),var(--accent-soft),var(--accent))]" : "bg-hairline")}>
              <span className="flex h-14 w-14 items-center justify-center rounded-full border-[3px] border-bg bg-surface-2 text-2xl">
                {/\p{Extended_Pictographic}/u.test(u.avatar) ? u.avatar : <span className="font-display text-lg font-extrabold uppercase">{u.handle[0]}</span>}
              </span>
            </span>
            <span className="w-full truncate text-center text-[11px] text-muted">@{u.handle.replace("_demo", "")}</span>
            <span className={cn("tnum -mt-1 text-[10px] font-semibold", (u.units7 ?? 0) > 0 ? "text-win" : (u.units7 ?? 0) < 0 ? "text-loss" : "text-muted-2")}>
              {(u.units7 ?? 0) > 0 ? "+" : ""}{(u.units7 ?? 0).toFixed(1)}u
            </span>
          </Link>
        ))}
        {people.isLoading ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-14 w-14 shrink-0 rounded-full" />) : null}
      </section>

      <section className="space-y-3 px-4 pt-4">
        <h1 className="text-2xl">
          Lo que apuesta <span className="text-accent">la banda</span>
        </h1>

        {feed.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-40 w-full" />)
        ) : feed.isError ? (
          <div className="card p-6 text-center text-sm text-muted">No pudimos cargar el feed.</div>
        ) : (feed.data?.items ?? []).length === 0 ? (
          <div className="card p-6 text-center">
            <h2 className="text-xl">{tab === "following" ? "Aún no sigues a nadie" : "Nada todavía"}</h2>
            <p className="mt-2 text-sm text-muted">
              {tab === "following"
                ? status === "connected"
                  ? "Busca a la banda y síguelos para ver sus picks aquí."
                  : "Entra para seguir a la banda."
                : "La primera apuesta de la banda aparecerá aquí."}
            </p>
            <Link href={tab === "following" && status !== "connected" ? "/entrar" : "/buscar"} className="btn-accent mt-4 inline-block px-5 py-2.5 text-xs">
              {tab === "following" && status !== "connected" ? "Entrar" : "Buscar gente"}
            </Link>
          </div>
        ) : (
          feed.data!.items.map((item, i) => <FeedCard key={item.id} item={item} index={i} onTicket={(it) => setTicket(ticketFromItem(it))} />)
        )}

        {feed.data?.demo ? (
          <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Vista previa con datos de ejemplo. Los picks reales se leen de la blockchain.</p>
        ) : (
          <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Cada pick es una apuesta real, verificable en Polygon.</p>
        )}
      </section>

      <Sheet open={!!ticket} onClose={() => setTicket(null)} title="Boleto">
        {ticket ? <TicketShare data={ticket} onDone={() => setTicket(null)} /> : null}
      </Sheet>
    </>
  );
}
