"use client";

import { useState } from "react";
import TopBar from "./TopBar";
import FeedCard from "./FeedCard";
import { DEMO_BETS, DEMO_USERS, findUser } from "@/data/demo";
import { cn } from "@/lib/cn";

type Tab = "todos" | "siguiendo";

export default function HomeFeed() {
  const [tab, setTab] = useState<Tab>("todos");
  const bets = tab === "todos" ? DEMO_BETS : DEMO_BETS.filter((b) => ["lechanga", "paulovski"].includes(b.user));

  return (
    <>
      <TopBar
        right={
          <div className="flex rounded-full bg-surface p-0.5">
            {(["todos", "siguiendo"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-full px-3 py-1 font-display text-[10px] font-bold uppercase tracking-wide transition-colors",
                  tab === t ? "bg-accent text-white" : "text-muted",
                )}
              >
                {t === "todos" ? "Todos" : "Siguiendo"}
              </button>
            ))}
          </div>
        }
      />

      {/* Leaders rail */}
      <section className="no-scrollbar flex gap-3 overflow-x-auto px-4 pt-4">
        {DEMO_USERS.slice(0, 6).map((u, i) => (
          <a key={u.handle} href={`/u/${u.handle}`} className="rise flex w-16 shrink-0 flex-col items-center gap-1.5" style={{ animationDelay: `${i * 40}ms` }}>
            <span className={cn("rounded-full p-[2px]", u.streak >= 3 ? "bg-[conic-gradient(var(--accent),var(--accent-soft),var(--accent))]" : "bg-hairline")}>
              <span className="flex h-14 w-14 items-center justify-center rounded-full border-[3px] border-bg bg-surface-2 text-2xl">{u.avatar}</span>
            </span>
            <span className="w-full truncate text-center text-[11px] text-muted">@{u.handle.replace("_demo", "")}</span>
          </a>
        ))}
      </section>

      <section className="space-y-3 px-4 pt-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl">
            Lo que apuesta <span className="text-accent">la banda</span>
          </h1>
        </div>
        {bets.map((b, i) => {
          const u = findUser(b.user);
          return u ? <FeedCard key={b.id} bet={b} user={u} index={i} /> : null;
        })}
        <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Vista previa con datos de ejemplo. Los picks reales se leen de la blockchain.</p>
      </section>
    </>
  );
}
