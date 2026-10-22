"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import type { Hex } from "viem";
import TopBar from "./TopBar";
import Avatar from "./Avatar";
import Sheet from "./Sheet";
import RoundClash from "./RoundClash";
import TicketShare from "./TicketShare";
import type { TicketData } from "./Ticket";
import { Share2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useWallet } from "@/providers/WalletContext";
import { useMe } from "@/providers/MeProvider";
import { useTrading } from "@/providers/TradingProvider";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { loadSecret, useArenaActions, useArenaMatch, useArenaMe } from "@/hooks/useArena";
import { BEST_OF, COMMIT_SECONDS, LOBBY_STAKE_USD, MOVE_LABEL, isArenaConfigured, toMatchStruct, toUnits, type Move } from "@/lib/arena/typed-data";
import { formatUsd } from "@/lib/polymarket/odds";

/**
 * Batalla — real PvP piedra·papel·tijera on the Arena contract.
 * $1 lobby · mejor de 3 · ganas $2 · sin casa, sin comisión.
 * Every step is a silent EIP-712 signature with the user's embedded wallet:
 * match agreement → per-round commit → reveal → result. Settlement is batched
 * on-chain by Patoli's operator; the chain only accepts what both players signed.
 */

const MOVES: Move[] = [1, 2, 3];


export default function BattleArena() {
  const { status, eoaAddress } = useWallet();
  const { me, status: meStatus } = useMe();
  const arenaMe = useArenaMe();
  const [matchId, setMatchId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const openId = arenaMe.data?.matchId ?? null;
  const activeId = matchId ?? (openId && openId !== dismissed ? openId : null);

  if (!isArenaConfigured()) {
    return (
      <>
        <TopBar title="Batalla" />
        <section className="px-4 pt-8 text-center">
          <div className="text-6xl">✊✋✌️</div>
          <h1 className="mt-4 text-3xl">Muy pronto</h1>
          <p className="mx-auto mt-2 max-w-[30ch] text-sm text-muted">La arena aún no está activa en este entorno.</p>
        </section>
      </>
    );
  }

  // Session restoring / profile loading → neutral skeleton, never the logged-out screen
  if (status === "loading" || (status === "connected" && !me && meStatus !== "unavailable")) {
    return (
      <>
        <TopBar title="Batalla" />
        <div className="space-y-3 px-4 pt-4">
          <div className="skeleton h-72" />
        </div>
      </>
    );
  }

  if (status !== "connected" || !me) {
    return (
      <>
        <TopBar title="Batalla" />
        <section className="px-4 pt-8 text-center">
          <div className="text-6xl">✊✋✌️</div>
          <h1 className="mt-4 text-3xl">
            Piedra, papel
            <br />
            <span className="text-accent">o tijera</span>
          </h1>
          <p className="mx-auto mt-2 max-w-[30ch] text-sm text-muted">$1 contra otro jugador. Mejor de 3. Ganas $2. Sin casa, sin comisión.</p>
          <Link href="/entrar?next=/batalla" className="btn-accent mt-6 inline-block w-full py-3.5 text-sm">
            Entrar para jugar
          </Link>
        </section>
      </>
    );
  }

  return (
    <>
      <TopBar title="Batalla" />
      <section className="px-4 pt-4">
        {activeId ? (
          <MatchView
            id={activeId}
            myEoa={(eoaAddress ?? "").toLowerCase() as Hex}
            onRematch={(newId) => {
              setDismissed(null);
              setMatchId(newId);
            }}
            onExit={() => {
              setDismissed(activeId);
              setMatchId(null);
              arenaMe.refetch();
            }}
          />
        ) : (
          <Lobby
            balance={arenaMe.data?.balance ?? 0}
            stranded={arenaMe.data?.waiting ?? 0}
            loading={arenaMe.isLoading}
            onMatched={(id) => {
              setDismissed(null);
              setMatchId(id);
            }}
            onFunded={() => arenaMe.refetch()}
          />
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ lobby */

function Lobby({ balance, stranded, loading, onMatched, onFunded }: { balance: number; stranded: number; loading: boolean; onMatched: (id: string) => void; onFunded: () => void }) {
  const actions = useArenaActions();
  const { depositArena, isReady } = useTrading();
  const { balance: walletBal, refetch } = useUsdcBalance();
  const [queued, setQueued] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState<"join" | "fund" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fundAmt, setFundAmt] = useState<number | null>(null);
  const stake = LOBBY_STAKE_USD;
  const canPlay = balance >= stake;
  const chips = [2, 5, 10, 20];
  const amt = fundAmt ?? chips.filter((c) => c <= walletBal).pop() ?? 2; // largest chip the wallet can cover

  // while queued, poll the lobby until a rival shows up
  useEffect(() => {
    if (!queued) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const s = await actions.lobbyStatus();
        if (!alive) return;
        if (s.matchId) {
          setQueued(false);
          onMatched(s.matchId);
        } else {
          setWaiting(s.waiting);
          if (!s.queued) {
            // expired → re-join silently
            const r = await actions.joinLobby(stake);
            if (r.matchId) onMatched(r.matchId);
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [queued, actions, onMatched, stake]);

  async function join() {
    setErr(null);
    setBusy("join");
    try {
      const r = await actions.joinLobby(stake);
      if (r.matchId) onMatched(r.matchId);
      else setQueued(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo entrar");
    } finally {
      setBusy(null);
    }
  }

  async function leave() {
    setQueued(false);
    try {
      await actions.leaveLobby();
    } catch {
      /* ignore */
    }
  }

  // funds that reached the forwarder but were not swept yet (e.g. the page closed mid-way)
  async function finishSweep() {
    setErr(null);
    setBusy("fund");
    try {
      await actions.sweep();
      onFunded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo acreditar");
    } finally {
      setBusy(null);
    }
  }

  async function fund() {
    setErr(null);
    setBusy("fund");
    try {
      await depositArena(toUnits(amt)); // relayer: plain transfer to your forwarder
      await actions.sweep(); // operator: forwarder → Arena, credited to you
      await refetch();
      onFunded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo fondear");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="card p-5 text-center">
        <div className="text-5xl">✊✋✌️</div>
        <h1 className="mt-3 text-2xl">
          Lobby de <span className="text-accent">${stake}</span>
        </h1>
        <p className="mt-1 text-sm text-muted">Mejor de 3 · ganas ${stake * 2} · sin casa, sin comisión</p>
        <div className="tnum mt-4 flex items-center justify-center gap-6 text-xs text-muted">
          <span>
            Arena <b className="text-ink">${loading ? "…" : formatUsd(balance)}</b>
          </span>
          <span>
            Saldo <b className="text-ink">${formatUsd(walletBal)}</b>
          </span>
        </div>

        {stranded > 0 ? (
          <button onClick={finishSweep} disabled={busy !== null} className="btn-accent mt-4 w-full py-3 text-sm">
            {busy === "fund" ? "Acreditando…" : `Acreditar $${formatUsd(stranded)} a tu arena`}
          </button>
        ) : null}
        {queued ? (
          <div className="mt-5">
            <div className="pulse-soft font-display text-sm font-extrabold uppercase text-accent-soft">Buscando rival…</div>
            <p className="mt-1 text-xs text-muted">{waiting > 1 ? `${waiting} en el lobby` : "Eres el primero. En cuanto entre alguien, arranca."}</p>
            <button onClick={leave} className="btn-ghost mt-4 w-full py-2.5 text-xs">
              Salir del lobby
            </button>
          </div>
        ) : loading ? (
          <div className="skeleton mt-5 h-12" />
        ) : canPlay ? (
          <button onClick={join} disabled={busy !== null} className="btn-accent mt-5 w-full py-3.5 text-sm">
            {busy === "join" ? "Entrando…" : `Buscar rival · $${stake}`}
          </button>
        ) : (
          <div className="mt-5 text-left">
            <div className="font-display text-sm font-extrabold uppercase">Fondea tu arena</div>
            <p className="mt-1 text-xs text-muted">Mueve pUSD de tu saldo a la arena. Una firma, sin gas. Lo sacas cuando quieras.</p>
            <div className="mt-3 flex gap-2">
              {chips.map((a) => (
                <button
                  key={a}
                  onClick={() => setFundAmt(a)}
                  className={cn("tnum flex-1 rounded-xl border py-2 text-sm font-semibold", amt === a ? "border-accent bg-[rgba(255,61,23,.12)] text-accent-soft" : "border-hairline bg-surface")}
                >
                  ${a}
                </button>
              ))}
            </div>
            <button onClick={fund} disabled={busy !== null || !isReady || walletBal < amt} className="btn-accent mt-3 w-full py-3 text-sm">
              {busy === "fund" ? "Fondeando…" : !isReady ? "Activa tu cuenta en Perfil" : walletBal < amt ? "Saldo insuficiente" : `Fondear ${amt}`}
            </button>
          </div>
        )}
        {err ? <p className="mt-3 text-xs text-loss">{err}</p> : null}
      </div>
      <p className="mt-4 text-center text-[11px] text-muted-2">
        Cada jugada va firmada con tu wallet. El contrato repite la partida con esas jugadas y paga solo. Nadie, ni Patoli, puede inventarse un resultado.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ match */

function MatchView({ id, myEoa, onExit, onRematch }: { id: string; myEoa: Hex; onExit: () => void; onRematch: (newId: string) => void }) {
  const q = useArenaMatch(id);
  const actions = useArenaActions();
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [myPick, setMyPick] = useState<{ round: number; move: Move } | null>(null); // optimistic
  const [share, setShare] = useState(false);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [clash, setClash] = useState<number | null>(null); // round whose clash is on screen
  const shownRef = useRef(0); // highest resolved round already shown
  const [now, setNow] = useState(() => Date.now());
  const once = useRef(new Set<string>());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // A newly resolved round → hold the clash on screen for ~2.4s, then move on.
  const lastResolvedRound = q.data?.rounds.reduce((mx, r) => (r.outcome && r.round > mx ? r.round : mx), 0) ?? 0;
  useEffect(() => {
    const r = lastResolvedRound;
    if (!r || r <= shownRef.current) return;
    const prev = shownRef.current;
    shownRef.current = r;
    const t1 = setTimeout(() => setClash(r), 0);
    const t2 = setTimeout(() => setClash((c) => (c === r ? null : c)), 2400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      shownRef.current = prev;
    };
  }, [lastResolvedRound]);

  const state = q.data ?? null;
  const m = state?.match ?? null;
  const side: "a" | "b" | null = m ? (m.eoa_a.toLowerCase() === myEoa ? "a" : m.eoa_b.toLowerCase() === myEoa ? "b" : null) : null;
  const cur = m && state ? state.rounds.find((r) => r.round === m.round) ?? null : null;

  // --- automatic protocol steps (each runs once per key) ---
  useEffect(() => {
    if (!m || !side) return;
    const run = async (key: string, fn: () => Promise<void>) => {
      if (once.current.has(key)) return;
      once.current.add(key);
      try {
        await fn();
      } catch (e) {
        once.current.delete(key);
        setErr(e instanceof Error ? e.message : "error");
      }
    };
    const mySig = side === "a" ? m.sig_a : m.sig_b;
    if (m.status === "signing" && !mySig) void run(`sign:${m.id}`, () => actions.signMatch(toMatchStruct(m)));

    // round open and I haven't committed → pre-sign the three moves while the player thinks
    const myC = cur ? (side === "a" ? cur.commit_a : cur.commit_b) : null;
    if (m.status === "playing" && cur && !cur.outcome && !myC) void run(`prep:${m.id}:${cur.round}`, () => actions.prepare(m.id as Hex, cur.round).then(() => undefined));

    if (m.status === "playing" && cur && !cur.outcome && cur.commit_a && cur.commit_b && loadSecret(m.id, cur.round)) {
      void run(`reveal:${m.id}:${cur.round}`, () => actions.reveal(m.id, cur.round));
    }

    // timeouts → ask the server to apply the rule
    const deadline = cur && !cur.outcome ? (cur.commit_a && cur.commit_b ? cur.reveal_deadline : cur.commit_deadline) : null;
    if (m.status === "playing" && deadline && new Date(deadline).getTime() + 1500 < now) void run(`tick:${m.id}:${cur!.round}:${deadline}`, () => actions.tick(m.id));
    if (m.status === "signing" && new Date(m.created_at).getTime() + 22_000 < now) void run(`tick:sign:${m.id}`, () => actions.tick(m.id));

    // doble o nada accepted by both → jump to the new match
    if (m.rematch_id) void run(`rematch:${m.id}`, async () => onRematch(m.rematch_id!));
    // rival proposed → buzz once
    const theirs = side === "a" ? m.rematch_b_at : m.rematch_a_at;
    const mine = side === "a" ? m.rematch_a_at : m.rematch_b_at;
    if (theirs && !mine && !m.rematch_id)
      void run(`buzz:${m.id}`, async () => {
        try {
          navigator.vibrate?.([80, 40, 80]);
        } catch {
          /* no haptics */
        }
      });
  }, [m, cur, side, now, actions, onRematch]);

  if (!state || !m || !side) {
    return <div className="skeleton h-64" />;
  }

  const meP = state.players ? (side === "a" ? state.players.a : state.players.b) : null;
  const rivalP = state.players ? (side === "a" ? state.players.b : state.players.a) : null;
  const rival = rivalP?.handle ?? (side === "a" ? m.player_b : m.player_a);
  const myScore = side === "a" ? m.score_a : m.score_b;
  const theirScore = side === "a" ? m.score_b : m.score_a;
  const myCommit = cur ? (side === "a" ? cur.commit_a : cur.commit_b) : null;
  const theirCommit = cur ? (side === "a" ? cur.commit_b : cur.commit_a) : null;
  const deadline = cur && !cur.outcome ? (cur.commit_a && cur.commit_b ? cur.reveal_deadline : cur.commit_deadline) : null;
  const secondsLeft = deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000)) : null;
  const iWon = m.winner_eoa && m.winner_eoa.toLowerCase() === myEoa;
  const done = m.status === "finished" || m.status === "ready" || m.status === "settled" || m.status === "disputed";
  const draw = done && !m.winner_eoa;
  const lastResolved = [...state.rounds].reverse().find((r) => r.outcome);
  const pendingClash = clash != null ? state.rounds.find((r) => r.round === clash) ?? null : null;
  const clashing = !!pendingClash && !done;
  const optimistic = myPick && cur && myPick.round === cur.round ? myPick.move : null;
  // doble o nada state
  const myRematch = side === "a" ? m.rematch_a_at : m.rematch_b_at;
  const theirRematch = side === "a" ? m.rematch_b_at : m.rematch_a_at;
  const rematchExpires = m.rematch_expires_at ? new Date(m.rematch_expires_at).getTime() : null;
  const rematchOpen = rematchExpires != null && now < rematchExpires;
  const rematchExpired = rematchExpires != null && now >= rematchExpires && !m.rematch_id;
  const rematchLeft = rematchExpires != null ? Math.max(0, rematchExpires - now) : 0;
  const nextStake = Number(m.stake); // doble o nada = same stake again
  const myBal = state.balances ? (side === "a" ? state.balances.a : state.balances.b) : null;
  const theirBal = state.balances ? (side === "a" ? state.balances.b : state.balances.a) : null;
  const iCantAfford = myBal != null && myBal < nextStake;
  const theyCantAfford = theirBal != null && theirBal < nextStake;
  const rematchError = m.rematch_error ? m.rematch_error.replace("El jugador A", side === "a" ? "Tú" : `@${rival}`).replace("El jugador B", side === "b" ? "Tú" : `@${rival}`).replace("Tú no tiene", "No tienes") : null;

  async function doubleOrNothing() {
    setErr(null);
    setRematchBusy(true);
    try {
      await actions.rematch(m!.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo");
    } finally {
      setRematchBusy(false);
    }
  }
  const sealed = !!myCommit || !!optimistic;

  async function pick(move: Move) {
    if (!cur || myCommit || picking) return;
    setErr(null);
    setPicking(true);
    setMyPick({ round: cur.round, move }); // instant feedback; the server confirms behind it
    try {
      await actions.commit(m!.id as Hex, cur.round, move);
    } catch (e) {
      setMyPick(null);
      setErr(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setPicking(false);
    }
  }

  return (
    <div>
      {/* scoreboard */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <PlayerChip label={meP ? `@${meP.handle}` : "Tú"} avatar={meP?.avatar ?? "🫵"} score={myScore} />
          <div className="text-center">
            <div className="text-[11px] uppercase tracking-wider text-muted">Mejor de {m.best_of || BEST_OF}</div>
            <div className="tnum font-display text-2xl font-extrabold">
              {myScore} - {theirScore}
            </div>
            <div className="tnum text-[11px] text-muted">${formatUsd(Number(m.stake))} · ganas ${formatUsd(Number(m.stake) * 2)}</div>
          </div>
          <PlayerChip label={rivalP ? `@${rivalP.handle}` : "Rival"} avatar={rivalP?.avatar ?? rival.slice(0, 1)} score={theirScore} />
        </div>
      </div>

      <AnimatePresence mode="wait">
        {m.status === "signing" ? (
          <Stage key="signing" title="Rival encontrado" sub="Firmando la partida… un segundo." pulse />
        ) : m.status === "cancelled" ? (
          <Stage key="cancelled" title="Se canceló" sub="El rival nunca firmó. No se movió ni un peso.">
            <button onClick={onExit} className="btn-accent mt-4 w-full py-3 text-sm">
              Volver al lobby
            </button>
          </Stage>
        ) : clashing && pendingClash ? (
          <motion.div key={`clash${pendingClash.round}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card mt-3 p-2">
            <RoundClash
              round={pendingClash.round}
              mine={(side === "a" ? pendingClash.move_a : pendingClash.move_b) as Move | null}
              theirs={(side === "a" ? pendingClash.move_b : pendingClash.move_a) as Move | null}
              outcome={pendingClash.outcome === "tie" ? "tie" : pendingClash.outcome === side ? "me" : "them"}
              meLabel={meP ? `@${meP.handle}` : "Tú"}
              themLabel={rivalP ? `@${rivalP.handle}` : "Rival"}
            />
          </motion.div>
        ) : m.status === "playing" && cur ? (
          <motion.div key={`r${cur.round}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card mt-3 p-4">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted">
              <span>Ronda {cur.round}</span>
              <span className={cn("tnum", secondsLeft != null && secondsLeft <= 5 && "text-loss")}>{!sealed && secondsLeft != null ? `${secondsLeft}s` : ""}</span>
            </div>
            {!sealed ? (
              <>
                <div className="mt-2 font-display text-lg font-extrabold uppercase">Elige tu jugada</div>
                <TimeBar msLeft={deadline ? Math.max(0, new Date(deadline).getTime() - now) : 0} total={COMMIT_SECONDS * 1000} />
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {MOVES.map((mv) => (
                    <motion.button
                      key={mv}
                      whileTap={{ scale: 0.92 }}
                      onClick={() => pick(mv)}
                      disabled={picking}
                      className="card flex flex-col items-center gap-1 py-4 active:border-accent active:bg-[rgba(255,61,23,.12)]"
                    >
                      <span className="text-4xl">{MOVE_LABEL[mv].emoji}</span>
                      <span className="text-xs text-muted">{MOVE_LABEL[mv].label}</span>
                    </motion.button>
                  ))}
                </div>
                <p className="mt-2 text-center text-[11px] text-muted-2">{theirCommit ? "Tu rival ya eligió." : "Tu rival está eligiendo…"}</p>
              </>
            ) : (
              <div className="mt-3 flex flex-col items-center py-3">
                <motion.div
                  initial={{ scale: 0.6, rotate: -10, opacity: 0 }}
                  animate={{ scale: 1, rotate: 0, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 18 }}
                  className="relative flex h-24 w-24 items-center justify-center rounded-2xl bg-surface"
                >
                  <span className="text-5xl">{optimistic ? MOVE_LABEL[optimistic].emoji : "🔒"}</span>
                  <motion.span
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.15, type: "spring", stiffness: 500, damping: 20 }}
                    className="absolute -right-2 -top-2 rounded-full bg-accent px-2 py-0.5 font-display text-[10px] font-extrabold uppercase text-white"
                  >
                    {myCommit ? "Sellada" : "Sellando"}
                  </motion.span>
                </motion.div>
                <p className="pulse-soft mt-4 text-sm text-muted">{!theirCommit ? "Esperando al rival…" : "Revelando jugadas…"}</p>
              </div>
            )}
          </motion.div>
        ) : done ? (
          <Stage
            key="done"
            title={draw ? "Empate" : iWon ? "Ganaste" : "Perdiste"}
            sub={
              draw
                ? "Nadie gana, nadie pierde. Cada quien con lo suyo."
                : iWon
                  ? `+$${formatUsd(Number(m.stake))} a tu arena.`
                  : `-$${formatUsd(Number(m.stake))} de tu arena. La próxima cae.`
            }
            tone={draw ? "muted" : iWon ? "win" : "loss"}
          >
            {lastResolved ? (
              <RoundClash
                round={lastResolved.round}
                mine={(side === "a" ? lastResolved.move_a : lastResolved.move_b) as Move | null}
                theirs={(side === "a" ? lastResolved.move_b : lastResolved.move_a) as Move | null}
                outcome={lastResolved.outcome === "tie" ? "tie" : lastResolved.outcome === side ? "me" : "them"}
                meLabel={meP ? `@${meP.handle}` : "Tú"}
                themLabel={rivalP ? `@${rivalP.handle}` : "Rival"}
              />
            ) : null}
            <p className="mt-3 text-[11px] text-muted-2">
              {m.status === "settled"
                ? "Liquidado en Polygon."
                : m.status === "ready"
                  ? "Resultado definido por las jugadas. Liquidando en la blockchain…"
                  : m.status === "disputed"
                    ? "Registrado en la blockchain. Se paga en 24 h."
                    : "Partida sin terminar. Registrando en la blockchain…"}
              {m.settle_tx ? (
                <>
                  {" "}
                  <a className="underline" href={`https://polygonscan.com/tx/${m.settle_tx}`} target="_blank" rel="noreferrer">
                    ver tx
                  </a>
                </>
              ) : null}
            </p>
            {/* Doble o nada */}
            {m.rematch_id ? (
              <p className="pulse-soft mt-4 text-sm text-accent-soft">Va la revancha…</p>
            ) : rematchError ? (
              <p className="mt-4 text-xs text-loss">{rematchError}</p>
            ) : iCantAfford ? (
              <p className="mt-4 text-xs text-muted">Te falta saldo en la arena para la revancha. Sal al lobby y fondea.</p>
            ) : theyCantAfford ? (
              <p className="mt-4 text-xs text-muted">@{rival} no tiene saldo en la arena para la revancha.</p>
            ) : rematchExpired ? (
              <p className="mt-4 text-xs text-muted">Se acabó el tiempo para la revancha.</p>
            ) : theirRematch && !myRematch ? (
              <div className="mt-4 rounded-2xl border border-accent bg-[rgba(255,61,23,.10)] p-3">
                <div className="font-display text-sm font-extrabold uppercase text-accent-soft">@{rival} quiere doble o nada</div>
                <p className="mt-0.5 text-xs text-muted">${formatUsd(nextStake)} cada quien. Ganas ${formatUsd(nextStake * 2)}.</p>
                <TimeBar msLeft={rematchLeft} total={10_000} />
                <button onClick={doubleOrNothing} disabled={rematchBusy} className="btn-accent mt-3 w-full py-3 text-sm">
                  {rematchBusy ? "Entrando…" : `Aceptar · $${formatUsd(nextStake)}`}
                </button>
              </div>
            ) : myRematch && rematchOpen ? (
              <div className="mt-4 rounded-2xl bg-surface p-3">
                <div className="pulse-soft font-display text-sm font-extrabold uppercase">Esperando a @{rival}…</div>
                <TimeBar msLeft={rematchLeft} total={10_000} />
              </div>
            ) : null}

            <div className="mt-4 flex gap-2">
              <button onClick={() => setShare(true)} className="btn-ghost flex items-center justify-center gap-1.5 px-4 py-3 text-sm" aria-label="Compartir">
                <Share2 className="h-4 w-4" />
              </button>
              {!myRematch && !rematchExpired && !m.rematch_id && !rematchError && !iCantAfford && !theyCantAfford ? (
                <button onClick={doubleOrNothing} disabled={rematchBusy} className="btn-accent flex-1 py-3 text-sm">
                  {rematchBusy ? "…" : `Doble o nada · $${formatUsd(nextStake)}`}
                </button>
              ) : null}
              <button onClick={onExit} className="btn-ghost flex-1 py-3 text-sm">
                Salir
              </button>
            </div>
          </Stage>
        ) : null}
      </AnimatePresence>
      {err ? <p className="mt-2 text-xs text-loss">{err}</p> : null}
      <Sheet open={share} onClose={() => setShare(false)} title="Tu boleto">
        {share ? (
          <TicketShare
            data={
              {
                handle: meP?.handle ?? "yo",
                avatar: meP?.avatar ?? "🫵",
                league: "Batalla",
                leagueEmoji: "✊",
                matchup: `vs @${rival}`,
                selection: `${draw ? "Empate" : iWon ? "Ganaste" : "Perdiste"} ${myScore}-${theirScore}`,
                market: "✊ Batalla",
                odds: 2,
                stake: Number(m.stake),
                payout: Number(m.stake) * 2,
                placedAt: m.finished_at ?? m.created_at,
                status: draw ? "void" : iWon ? "won" : "lost",
                proof: m.settle_tx ?? m.id,
              } satisfies TicketData
            }
            onDone={() => setShare(false)}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

/** A bar that drains from full to empty as the window closes. */
function TimeBar({ msLeft, total }: { msLeft: number; total: number }) {
  const pct = Math.max(0, Math.min(100, (msLeft / total) * 100));
  return (
    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,.08)]">
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-linear", pct > 30 ? "bg-accent" : "bg-loss")} style={{ width: `${pct}%` }} />
    </div>
  );
}

function PlayerChip({ label, avatar, score }: { label: string; avatar: string; score: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Avatar seed={avatar} size={44} />
      <span className="text-[11px] text-muted">{label}</span>
      <span className="sr-only">{score}</span>
    </div>
  );
}

function Stage({ title, sub, children, pulse, tone }: { title: string; sub: string; children?: React.ReactNode; pulse?: boolean; tone?: "win" | "loss" | "muted" }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card mt-3 p-5 text-center">
      <div className={cn("font-display text-2xl font-extrabold uppercase", pulse && "pulse-soft", tone === "win" && "text-win", tone === "loss" && "text-loss")}>{title}</div>
      <p className="mt-1 text-sm text-muted">{sub}</p>
      {children}
    </motion.div>
  );
}


