"use client";

import { motion } from "motion/react";
import { MOVE_LABEL, type Move } from "@/lib/arena/typed-data";
import { cn } from "@/lib/cn";

/**
 * The reveal: both hands slide in from the sides, a short beat, then the clash —
 * the winning hand grows, the losing hand shakes and fades, the verdict stamps in.
 * Pure presentation; timings are tuned so the whole thing reads in ~2 seconds.
 */
export default function RoundClash({
  round,
  mine,
  theirs,
  outcome,
  meLabel,
  themLabel,
}: {
  round: number;
  mine: Move | null;
  theirs: Move | null;
  outcome: "me" | "them" | "tie";
  meLabel: string;
  themLabel: string;
}) {
  const verdict = outcome === "tie" ? "Empate" : outcome === "me" ? "Punto para ti" : "Punto del rival";
  const tone = outcome === "tie" ? "text-muted" : outcome === "me" ? "text-win" : "text-loss";
  const CLASH = 0.55; // seconds until the hands meet

  const hand = (move: Move | null, who: "me" | "them") => {
    const wins = outcome === who;
    const loses = outcome !== "tie" && outcome !== who;
    const fromX = who === "me" ? -140 : 140;
    return (
      <motion.div
        key={`${round}-${who}`}
        className="flex flex-col items-center gap-1"
        initial={{ x: fromX, opacity: 0 }}
        animate={
          loses
            ? { x: [fromX, 0, 0, who === "me" ? -8 : 8, who === "me" ? 6 : -6, 0], opacity: [0, 1, 1, 0.45, 0.45, 0.45], scale: [1, 1, 1, 0.9, 0.9, 0.9] }
            : wins
              ? { x: [fromX, 0, 0, 0], opacity: 1, scale: [1, 1, 1.28, 1.28] }
              : { x: [fromX, 0], opacity: 1, scale: 1 }
        }
        transition={{ duration: loses || wins ? 1.3 : CLASH, times: loses ? [0, 0.4, 0.5, 0.65, 0.8, 1] : wins ? [0, 0.4, 0.6, 1] : undefined, ease: "easeOut" }}
      >
        <span className={cn("text-6xl drop-shadow", who === "them" && "-scale-x-100")}>{move ? MOVE_LABEL[move].emoji : "⏱️"}</span>
        <span className="text-[11px] text-muted">{move ? MOVE_LABEL[move].label : "Sin jugada"}</span>
      </motion.div>
    );
  };

  return (
    <div className="mt-3 rounded-2xl bg-surface px-4 py-5">
      <div className="text-center text-[11px] uppercase tracking-wider text-muted">Ronda {round}</div>
      <div className="mt-3 flex items-center justify-between px-2">
        <div className="w-24 text-center">
          {hand(mine, "me")}
          <div className="mt-1 truncate text-[11px] text-muted-2">{meLabel}</div>
        </div>
        <motion.div
          className="font-display text-2xl font-extrabold text-accent"
          initial={{ scale: 0, rotate: -20, opacity: 0 }}
          animate={{ scale: [0, 1.4, 1], rotate: [-20, 8, 0], opacity: 1 }}
          transition={{ delay: CLASH, duration: 0.35 }}
        >
          VS
        </motion.div>
        <div className="w-24 text-center">
          {hand(theirs, "them")}
          <div className="mt-1 truncate text-[11px] text-muted-2">{themLabel}</div>
        </div>
      </div>
      <motion.div
        className={cn("mt-4 text-center font-display text-lg font-extrabold uppercase", tone)}
        initial={{ opacity: 0, y: 10, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: CLASH + 0.5, type: "spring", stiffness: 300, damping: 18 }}
      >
        {verdict}
      </motion.div>
    </div>
  );
}
