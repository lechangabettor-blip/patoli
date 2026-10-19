"use client";

import { useState } from "react";
import RoundClash from "@/components/RoundClash";
import TopBar from "@/components/TopBar";
import type { Move } from "@/lib/arena/typed-data";

/** Design preview for the round reveal — no wallet, no match. Tap to replay. */
const CASES: { label: string; mine: Move | null; theirs: Move | null; outcome: "me" | "them" | "tie" }[] = [
  { label: "Gano: papel vs piedra", mine: 2, theirs: 1, outcome: "me" },
  { label: "Pierdo: piedra vs papel", mine: 1, theirs: 2, outcome: "them" },
  { label: "Empate: tijera vs tijera", mine: 3, theirs: 3, outcome: "tie" },
  { label: "Rival no jugó", mine: 1, theirs: null, outcome: "me" },
];

export default function ClashPreviewPage() {
  const [i, setI] = useState(0);
  const [key, setKey] = useState(0);
  const c = CASES[i];
  return (
    <>
      <TopBar title="Preview" />
      <main className="mx-auto max-w-md px-4 pb-24 pt-4">
        <div className="flex flex-wrap gap-2">
          {CASES.map((x, idx) => (
            <button
              key={x.label}
              onClick={() => {
                setI(idx);
                setKey((k) => k + 1);
              }}
              className={idx === i ? "btn-accent px-3 py-1.5 text-xs" : "btn-ghost px-3 py-1.5 text-xs"}
            >
              {x.label}
            </button>
          ))}
          <button onClick={() => setKey((k) => k + 1)} className="btn-ghost px-3 py-1.5 text-xs">
            Repetir
          </button>
        </div>
        <div key={key} className="card mt-4 p-2">
          <RoundClash round={2} mine={c.mine} theirs={c.theirs} outcome={c.outcome} meLabel="@lechangabettor" themLabel="@markz0014" />
        </div>
      </main>
    </>
  );
}
