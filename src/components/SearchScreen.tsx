"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { Search } from "lucide-react";
import TopBar from "./TopBar";
import Avatar from "./Avatar";
import { useUsers } from "@/hooks/useSocial";
import { LEAGUES, LEAGUE_BY_ID } from "@/lib/polymarket/leagues";
import type { Game } from "@/lib/polymarket/gamma";
import { kickoffLabel } from "@/lib/format";
import { useNow } from "@/hooks/useNow";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export default function SearchScreen() {
  const [q, setQ] = useState("");
  const now = useNow();
  const nq = norm(q.trim());

  const gameQueries = useQueries({
    queries: LEAGUES.map((l) => ({
      queryKey: ["games", l.id],
      queryFn: async (): Promise<Game[]> => {
        const r = await fetch(`/api/games?league=${l.id}`);
        return r.ok ? r.json() : [];
      },
      staleTime: 60_000,
      enabled: nq.length >= 2,
    })),
  });

  const usersQ = useUsers(nq);
  const users = usersQ.data?.items ?? [];
  const games = useMemo(() => {
    if (nq.length < 2) return [] as Game[];
    const all = gameQueries.flatMap((g) => g.data ?? []);
    return all.filter((g) => norm(g.title).includes(nq)).slice(0, 12);
  }, [gameQueries, nq]);

  return (
    <>
      <TopBar title="Buscar" />
      <div className="px-4 pt-4">
        <label className="flex items-center gap-2 rounded-2xl border border-hairline bg-surface px-3 focus-within:border-accent">
          <Search className="h-4 w-4 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Usuarios o partidos: @skilz, América, Chiefs…"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-2"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
      </div>

      <section className="px-4 pt-5">
        <h2 className="text-sm tracking-widest text-muted">Usuarios</h2>
        <ul className="mt-2 space-y-2">
          {users.map((u, i) => (
            <li key={u.handle} className="card rise flex items-center gap-3 px-3 py-2.5" style={{ animationDelay: `${i * 30}ms` }}>
              <Avatar seed={u.avatar} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-sm font-semibold">
                  @{u.handle} {u.verified ? <span className="text-accent">✦</span> : null}
                </div>
                <div className="tnum text-xs text-muted">
                  {u.record.w}-{u.record.l}
                  {u.record.open ? ` · ${u.record.open} abiertas` : ""} · ROI {u.roi >= 0 ? "+" : ""}
                  {u.roi.toFixed(1)}%
                </div>
              </div>
              <Link href={`/u/${u.handle}`} className="btn-ghost px-3 py-1.5 font-display text-[11px] font-bold uppercase">
                Ver
              </Link>
            </li>
          ))}
          {usersQ.isLoading ? <li className="skeleton h-14" /> : null}
          {!usersQ.isLoading && users.length === 0 ? <li className="text-sm text-muted">Nadie con ese nombre.</li> : null}
        </ul>
      </section>

      {nq.length >= 2 ? (
        <section className="px-4 pt-5">
          <h2 className="text-sm tracking-widest text-muted">Partidos</h2>
          <ul className="mt-2 space-y-2">
            {gameQueries.some((g) => g.isLoading) && games.length === 0 ? <li className="skeleton h-14" /> : null}
            {games.map((g) => (
              <li key={g.id}>
                <Link href={`/deportes?liga=${g.league}&partido=${encodeURIComponent(g.slug)}`} className="card flex items-center gap-3 px-3 py-2.5">
                  <span className="text-xl">{LEAGUE_BY_ID[g.league].emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{g.title}</div>
                    <div className="text-xs text-muted">
                      {LEAGUE_BY_ID[g.league].label} · {kickoffLabel(g.startTime, now)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
            {!gameQueries.some((g) => g.isLoading) && games.length === 0 ? <li className="text-sm text-muted">Ningún partido coincide.</li> : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}
