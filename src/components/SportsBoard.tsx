"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import TopBar from "./TopBar";
import GameCard, { type Selection } from "./GameCard";
import BetSheet from "./BetSheet";
import { LEAGUES, isLeagueId, type LeagueId } from "@/lib/polymarket/leagues";
import { useGames, usePrices } from "@/hooks/useGames";
import { cn } from "@/lib/cn";

export default function SportsBoard() {
  const sp = useSearchParams();
  const router = useRouter();
  const initial = sp.get("liga");
  const [league, setLeague] = useState<LeagueId>(isLeagueId(initial) ? initial : "ligamx");
  const [sel, setSel] = useState<Selection | null>(null);

  const games = useGames(league);
  const tokenIds = useMemo(
    () => (games.data ?? []).slice(0, 12).flatMap((g) => g.markets.flatMap((m) => m.outcomes.map((o) => o.tokenId))),
    [games.data],
  );
  const prices = usePrices(tokenIds);

  function pick(id: LeagueId) {
    setLeague(id);
    router.replace(`/deportes?liga=${id}`, { scroll: false });
  }

  return (
    <>
      <TopBar title="Deportes" />
      <div className="sticky z-20 border-b border-hairline bg-[rgba(31,31,41,0.85)] backdrop-blur-xl" style={{ top: "var(--top-h)" }}>
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-3">
          {LEAGUES.map((l) => (
            <button
              key={l.id}
              onClick={() => pick(l.id)}
              className={cn(
                "shrink-0 rounded-full border px-3.5 py-1.5 font-display text-[11px] font-bold uppercase tracking-wide transition-colors",
                league === l.id ? "border-accent bg-accent text-white" : "border-hairline bg-surface text-muted",
              )}
            >
              {l.emoji} {l.label}
            </button>
          ))}
        </div>
      </div>

      <section className="space-y-3 px-4 pt-4">
        {games.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-36 w-full" />)
        ) : games.isError ? (
          <Empty title="Sin señal" body="No pudimos cargar los partidos. Jala para intentar otra vez." />
        ) : (games.data ?? []).length === 0 ? (
          <Empty title="Nada por ahora" body="Polymarket aún no abre mercados para esta liga. Vuelve más cerca del partido." />
        ) : (
          games.data!.map((g, i) => <GameCard key={g.id} game={g} prices={prices.data} onPick={setSel} index={i} />)
        )}
        <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">
          Precios en vivo de Polymarket · tu precio ya incluye comisiones · prematch
        </p>
      </section>

      <BetSheet selection={sel} onClose={() => setSel(null)} />
    </>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-6 text-center">
      <h2 className="text-xl">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}
