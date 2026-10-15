"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import TopBar from "./TopBar";
import Avatar from "./Avatar";
import { cn } from "@/lib/cn";

/**
 * Lobby de $1 · mejor de 3 · ganas $2.
 * v1 UI with a simulated opponent so the flow can be designed and tested end
 * to end. Phase 3 wires it to the Arena contract (off-chain signed moves,
 * batched on-chain settlement) and real matchmaking. Clearly labelled demo.
 */

type Move = "piedra" | "papel" | "tijera";
type Phase = "lobby" | "matching" | "playing" | "result";
type Outcome = "win" | "lose" | "tie";

const MOVES: { id: Move; emoji: string; label: string }[] = [
  { id: "piedra", emoji: "✊", label: "Piedra" },
  { id: "papel", emoji: "✋", label: "Papel" },
  { id: "tijera", emoji: "✌️", label: "Tijera" },
];

const BEATS: Record<Move, Move> = { piedra: "tijera", papel: "piedra", tijera: "papel" };
const STAKE = 1;
const WIN_PAYOUT = 2;
const ROUND_SECONDS = 10;
const DEMO_RIVALS = [
  { handle: "skilz_demo", avatar: "🎯" },
  { handle: "wasat_demo", avatar: "🌙" },
  { handle: "ansess_demo", avatar: "⚡" },
];

interface Round {
  me: Move | null;
  them: Move | null;
  outcome: Outcome | null;
}

export default function BattleLobby() {
  const [phase, setPhase] = useState<Phase>("lobby");
  const [rival, setRival] = useState(DEMO_RIVALS[0]);
  const [score, setScore] = useState({ me: 0, them: 0 });
  const [round, setRound] = useState<Round>({ me: null, them: null, outcome: null });
  const [history, setHistory] = useState<Outcome[]>([]);
  const [timer, setTimer] = useState(ROUND_SECONDS);

  // Timers live in refs; all state changes happen from handlers/callbacks.
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const lockedRef = useRef(false);

  useEffect(() => {
    const timeouts = pending.current;
    return () => {
      if (tick.current) clearInterval(tick.current);
      timeouts.forEach(clearTimeout);
    };
  }, []);

  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    pending.current.push(id);
  };

  function stopTick() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
  }

  function startRound() {
    lockedRef.current = false;
    setRound({ me: null, them: null, outcome: null });
    setTimer(ROUND_SECONDS);
    stopTick();
    tick.current = setInterval(() => {
      setTimer((t) => {
        if (t <= 1) {
          stopTick();
          // Forfeit the round when time runs out (mirrors the on-chain timeout rule)
          queueMicrotask(() => throwMove(null));
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }

  function findRival() {
    setPhase("matching");
    setScore({ me: 0, them: 0 });
    setHistory([]);
    setRound({ me: null, them: null, outcome: null });
    const r = DEMO_RIVALS[Math.floor(Math.random() * DEMO_RIVALS.length)];
    later(() => {
      setRival(r);
      setPhase("playing");
      startRound();
    }, 1800);
  }

  function throwMove(me: Move | null) {
    if (lockedRef.current) return;
    lockedRef.current = true;
    stopTick();
    const them = MOVES[Math.floor(Math.random() * 3)].id;
    const outcome: Outcome = me == null ? "lose" : me === them ? "tie" : BEATS[me] === them ? "win" : "lose";
    setRound({ me, them, outcome });
    const prev = scoreRef.current;
    const next = { me: prev.me + (outcome === "win" ? 1 : 0), them: prev.them + (outcome === "lose" ? 1 : 0) };
    scoreRef.current = next;
    setScore(next);
    setHistory((h) => [...h, outcome]);
    later(() => {
      if (next.me === 2 || next.them === 2) setPhase("result");
      else startRound();
    }, 1400);
  }

  function exit() {
    stopTick();
    setPhase("lobby");
  }

  const won = score.me === 2;
  const rivalName = `@${rival.handle.replace("_demo", "")}`;

  return (
    <>
      <TopBar title="Batalla" />
      <section className="px-4 pt-5">
        <div className="card-hot card relative overflow-hidden p-5">
          <div className="absolute -right-6 -top-8 select-none text-[120px] opacity-[0.08]">✊</div>
          <div className="font-display text-[11px] font-bold uppercase tracking-widest text-accent-soft">Piedra · Papel · Tijera</div>
          <h1 className="mt-1 text-3xl">
            Reta a la banda
            <br />
            <span className="text-accent">$1 · mejor de 3</span>
          </h1>
          <p className="mt-2 max-w-[28ch] text-sm text-muted">Te emparejamos con alguien al instante. Quien gane dos rondas se lleva los $2. Sin casa, sin comisión.</p>

          <AnimatePresence mode="wait">
            {phase === "lobby" ? (
              <motion.div key="lobby" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-5">
                <button onClick={findRival} className="btn-accent w-full py-4 text-base">
                  Buscar rival · ${STAKE}
                </button>
                <div className="tnum mt-3 flex items-center justify-between text-xs text-muted">
                  <span>🟢 23 en el lobby</span>
                  <span>Ganas ${WIN_PAYOUT}.00</span>
                </div>
              </motion.div>
            ) : null}

            {phase === "matching" ? (
              <motion.div key="matching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-6 flex flex-col items-center gap-3 py-4">
                <div className="relative flex h-20 w-20 items-center justify-center">
                  <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
                  <span className="relative text-4xl">⚔️</span>
                </div>
                <p className="pulse-soft font-display text-sm font-bold uppercase tracking-widest text-accent-soft">Buscando rival…</p>
              </motion.div>
            ) : null}

            {phase === "playing" ? (
              <motion.div key="playing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-5">
                <Scoreboard me={score.me} them={score.them} rival={rival} />
                <div className="mt-4 flex h-28 items-center justify-center gap-6">
                  <Hand move={round.me} side="me" reveal={!!round.outcome} />
                  <span className="font-display text-sm font-extrabold uppercase text-muted">vs</span>
                  <Hand move={round.them} side="them" reveal={!!round.outcome} />
                </div>
                <div className="mt-1 h-6 text-center font-display text-sm font-extrabold uppercase">
                  {round.outcome === "win" ? <span className="text-win">Ronda tuya</span> : null}
                  {round.outcome === "lose" ? <span className="text-loss">Ronda de {rivalName}</span> : null}
                  {round.outcome === "tie" ? <span className="text-muted">Empate, va otra</span> : null}
                  {!round.outcome ? <span className={cn("tnum", timer <= 3 ? "text-loss" : "text-muted")}>Tira en {timer}s</span> : null}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {MOVES.map((m) => (
                    <button
                      key={m.id}
                      disabled={!!round.outcome}
                      onClick={() => throwMove(m.id)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-2xl border py-4 transition-all",
                        round.me === m.id ? "scale-[1.03] border-accent bg-[rgba(255,61,23,.14)]" : "border-hairline bg-surface active:scale-95",
                        round.me && round.me !== m.id ? "opacity-40" : "",
                      )}
                    >
                      <span className="text-4xl">{m.emoji}</span>
                      <span className="font-display text-[11px] font-bold uppercase tracking-wide text-muted">{m.label}</span>
                    </button>
                  ))}
                </div>
              </motion.div>
            ) : null}

            {phase === "result" ? (
              <motion.div key="result" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 text-center">
                <div className="text-6xl">{won ? "🏆" : "💀"}</div>
                <h2 className={cn("mt-2 text-3xl", won ? "text-win" : "text-loss")}>{won ? `Ganaste $${WIN_PAYOUT}` : `Perdiste $${STAKE}`}</h2>
                <p className="tnum mt-1 text-sm text-muted">
                  {score.me}–{score.them} vs {rivalName} · {history.map((h) => (h === "win" ? "🟢" : h === "lose" ? "🔴" : "⚪")).join(" ")}
                </p>
                <div className="mt-5 flex gap-2">
                  <button onClick={findRival} className="btn-accent flex-1 py-3.5 text-sm">
                    Revancha · $1
                  </button>
                  <button onClick={exit} className="btn-ghost px-5 py-3.5 font-display text-xs font-bold uppercase">
                    Salir
                  </button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat k="Tu récord" v="0–0" />
          <Stat k="Racha" v="—" />
          <Stat k="Ganado" v="$0" />
        </div>

        <h2 className="mt-6 text-lg">Reyes del Patoli</h2>
        <ol className="mt-2 space-y-2">
          {[
            { h: "skilz_demo", a: "🎯", w: 41, l: 22 },
            { h: "funguis_demo", a: "🍄", w: 30, l: 19 },
            { h: "lechanga", a: "🦧", w: 25, l: 24 },
          ].map((r, i) => (
            <li key={r.h} className="card flex items-center gap-3 px-3 py-2.5">
              <span className="tnum w-5 font-display text-lg font-extrabold text-accent-soft">{i + 1}</span>
              <Avatar seed={r.a} size={32} />
              <span className="flex-1 truncate text-sm font-semibold">@{r.h.replace("_demo", "")}</span>
              <span className="tnum text-xs text-muted">
                {r.w}–{r.l}
              </span>
            </li>
          ))}
        </ol>
        <p className="pb-2 pt-4 text-center text-[11px] text-muted-2">Demo: rival simulado. Las partidas reales se firman y se liquidan on-chain (sin gas para ti).</p>
      </section>
    </>
  );
}

function Scoreboard({ me, them, rival }: { me: number; them: number; rival: { handle: string; avatar: string } }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-surface/70 px-4 py-3">
      <div className="flex items-center gap-2">
        <Avatar seed="🦧" size={32} />
        <span className="text-sm font-semibold">Tú</span>
      </div>
      <div className="tnum font-display text-3xl font-extrabold">
        <span className={cn(me > them ? "text-win" : "")}>{me}</span>
        <span className="mx-2 text-muted">–</span>
        <span className={cn(them > me ? "text-loss" : "")}>{them}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">@{rival.handle.replace("_demo", "")}</span>
        <Avatar seed={rival.avatar} size={32} />
      </div>
    </div>
  );
}

function Hand({ move, side, reveal }: { move: Move | null; side: "me" | "them"; reveal: boolean }) {
  const emoji = move ? MOVES.find((m) => m.id === move)!.emoji : "✊";
  const show = side === "me" ? !!move : reveal;
  return (
    <motion.div
      key={`${side}-${move}-${reveal}`}
      initial={{ rotate: side === "me" ? -20 : 20, y: -6 }}
      animate={show ? { rotate: 0, y: 0 } : { rotate: side === "me" ? [-20, 10, -20] : [20, -10, 20], y: [0, -8, 0] }}
      transition={show ? { type: "spring", stiffness: 400, damping: 20 } : { repeat: Infinity, duration: 0.9 }}
      className={cn("text-6xl", side === "them" ? "-scale-x-100" : "")}
    >
      {show ? emoji : "✊"}
    </motion.div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="card px-3 py-2.5 text-center">
      <div className="tnum font-display text-xl font-extrabold">{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{k}</div>
    </div>
  );
}
