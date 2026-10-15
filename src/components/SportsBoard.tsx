"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import TopBar from "./TopBar";
import GameCard, { type Selection } from "./GameCard";
import BetSheet from "./BetSheet";
import { LEAGUES, isLeagueId, type LeagueId } from "@/lib/polymarket/leagues";
import { useGames, usePrices } from "@/hooks/useGames";
import { cn } from "@/lib/cn";

/**
 * The URL is the source of truth: /deportes?liga=nfl&partido=<slug>.
 * (Next keeps this component mounted across search-param changes, so local
 * state seeded from the first URL would go stale — that was the bug where a
 * search result landed on the wrong league.)
 */
export default function SportsBoard() {
  const sp = useSearchParams();
  const router = useRouter();
  const ligaParam = sp.get("liga");
  const league: LeagueId = isLeagueId(ligaParam) ? ligaParam : "ligamx";
  const focusSlug = sp.get("partido");
  const [sel, setSel] = useState<Selection | null>(null);

  const games = useGames(league);
  const ordered = useMemo(() => {
    const list = games.data ?? [];
    if (!focusSlug) return list;
    const i = list.findIndex((g) => g.slug === focusSlug);
    if (i <= 0) return list;
    return [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
  }, [games.data, focusSlug]);

  const tokenIds = useMemo(
    () => ordered.slice(0, 12).flatMap((g) => g.markets.flatMap((m) => m.outcomes.map((o) => o.tokenId))),
    [ordered],
  );
  const prices = usePrices(tokenIds);

  // Keep the active league chip in view when arriving from a deep link
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-league="${league}"]`);
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [league]);

  function pick(id: LeagueId) {
    router.replace(`/deportes?liga=${id}`, { scroll: false });
  }

  return (
    <>
      <TopBar title="Deportes" />
      <div className="sticky z-20 border-b border-hairline bg-[rgba(31,31,41,0.85)] backdrop-blur-xl" style={{ top: "var(--top-h)" }}>
        <div ref={railRef} className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-3">
          {LEAGUES.map((l) => (
            <button
              key={l.id}
              data-league={l.id}
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
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-44 w-full" />)
        ) : games.isError ? (
          <Empty title="Sin señal" body="No pudimos cargar los partidos." action={() => games.refetch()} />
        ) : ordered.length === 0 ? (
          <Empty title="Nada por ahora" body="Polymarket aún no abre mercados para esta liga. Vuelve más cerca del partido." />
        ) : (
          ordered.map((g, i) => (
            <div key={g.id} className={cn(g.slug === focusSlug && "rounded-[18px] ring-2 ring-accent/70")}>
              <GameCard game={g} prices={prices.data} onPick={setSel} index={i} />
            </div>
          ))
        )}
        <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">
          Precios en vivo de Polymarket · tu precio ya incluye comisiones · prematch
        </p>
      </section>

      <BetSheet selection={sel} onClose={() => setSel(null)} />
    </>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: () => void }) {
  return (
    <div className="card p-6 text-center">
      <h2 className="text-xl">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>
      {action ? (
        <button onClick={action} className="btn-ghost mt-4 px-4 py-2 font-display text-xs font-bold uppercase">
          Reintentar
        </button>
      ) : null}
    </div>
  );
}
