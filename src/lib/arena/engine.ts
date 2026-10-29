import "server-only";
import { randomBytes } from "crypto";
import { after } from "next/server";
import type { Hex } from "viem";
import { supabaseAdmin } from "@/lib/supabase/server";
import { parseEventLogs } from "viem";
import { arenaAbi } from "./abi";
import { withJobLock } from "@/lib/job-lock";
import { alertOps } from "@/lib/alert";
import {
  arenaBalance,
  arenaLimits,
  arenaSettledEvent,
  arenaPendingWithdraw,
  operatorGasBalance,
  readClaim,
  sendClaim,
  sendFinalize,
  sendSettleBatch,
  signCommitAck,
  signRevealAck,
  verifyCommitSig,
  verifyMatchSig,
  waitForTx,
  type ArenaIdentity,
  type ClaimCommit,
  type ClaimReveal,
  type SettleItem,
} from "./server";
import {
  COMMIT_SECONDS,
  fromUnits,
  MATCH_TTL_MINUTES,
  REVEAL_SECONDS,
  SIGN_SECONDS,
  beats,
  commitHash,
  toMatchStruct,
  toUnits,
  type Move,
} from "./typed-data";

/**
 * The match engine. State lives in Postgres; every transition is driven by a
 * player's request (sign / commit / reveal / result) or by `tick` (timeouts).
 * Nothing here can decide money on its own: the chain only accepts outcomes
 * signed by both players, or replays the players' own signed commits.
 *
 * The engine applies EXACTLY the contract's `_replay` rules, so the outcome both
 * players are asked to sign is the same one the chain would compute from the
 * signed artifacts: a missed commit or reveal (when the other side delivered)
 * loses that ROUND; a round where nobody commits/reveals is a tie and play goes
 * on; the first to the needed points wins (instant settlement). Nobody signs a result: a match completed by score becomes
 * `ready` and the cron settles it on-chain from the moves themselves; forfeits and
 * abandoned matches go through the on-chain claim (24h window) filed by the operator.
 */

type Side = "a" | "b";
/**
 * A match is ACTIVE while it is being played. Decided matches that are still settling
 * (ready) or in the on-chain claim path (finished/disputed, up to 24h) are NOT active:
 * they must not trap the player in the Batalla tab or block new games. What they still
 * owe is tracked as exposure by `unsettledOwed` and subtracted from the free balance.
 */
const OPEN_STATUSES = ["signing", "playing"] as const;

export interface MatchRow {
  id: string;
  player_a: string;
  player_b: string;
  eoa_a: string;
  eoa_b: string;
  stake: number;
  best_of: number;
  deadline: string;
  status: string;
  sig_a: string | null;
  sig_b: string | null;
  round: number;
  score_a: number;
  score_b: number;
  winner_eoa: string | null;
  settle_tx: string | null;
  claim_tx: string | null;
  rematch_a_at: string | null;
  rematch_b_at: string | null;
  rematch_expires_at: string | null;
  rematch_id: string | null;
  rematch_error: string | null;
  parent_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RoundRow {
  match_id: string;
  round: number;
  commit_a: string | null;
  commit_sig_a: string | null;
  commit_ack_a: string | null;
  committed_a_at: string | null;
  commit_b: string | null;
  commit_sig_b: string | null;
  commit_ack_b: string | null;
  committed_b_at: string | null;
  move_a: number | null;
  salt_a: string | null;
  reveal_ack_a: string | null;
  move_b: number | null;
  salt_b: string | null;
  reveal_ack_b: string | null;
  outcome: "a" | "b" | "tie" | null;
  opened_at: string;
  commit_deadline: string | null;
  reveal_deadline: string | null;
  resolved_at: string | null;
}

export class ArenaError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const MATCH_COLS = "id, player_a, player_b, eoa_a, eoa_b, stake, best_of, deadline, status, sig_a, sig_b, round, score_a, score_b, winner_eoa, settle_tx, claim_tx, rematch_a_at, rematch_b_at, rematch_expires_at, rematch_id, rematch_error, parent_id, created_at, started_at, finished_at";
const nowIso = () => new Date().toISOString();
const plus = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const past = (iso: string | null) => !!iso && new Date(iso).getTime() <= Date.now();

const newMatchId = (): Hex => `0x${randomBytes(32).toString("hex")}`;

/** ------------------------------------------------------------ lobby */

export async function openMatchFor(profileId: string): Promise<MatchRow | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("arena_matches")
    .select(MATCH_COLS)
    .or(`player_a.eq.${profileId},player_b.eq.${profileId}`)
    .in("status", [...OPEN_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as MatchRow | null) ?? null;
}

/** Stakes a player will still lose on-chain from matches that are decided but not yet settled. */
export async function unsettledOwed(eoa: string, excludeId?: string): Promise<bigint> {
  const db = supabaseAdmin();
  const e = eoa.toLowerCase();
  let q = db.from("arena_matches").select("id, stake, eoa_a, eoa_b, winner_eoa").in("status", ["finished", "ready", "disputed"]).or(`eoa_a.eq.${e},eoa_b.eq.${e}`);
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q;
  let owed = 0n;
  for (const r of data ?? []) {
    const w = (r.winner_eoa as string | null)?.toLowerCase();
    if (w && w !== e) owed += toUnits(Number(r.stake));
  }
  return owed;
}

/** Any open match for this profile other than `excludeId`. */
async function otherOpenMatch(profileId: string, excludeId: string): Promise<MatchRow | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("arena_matches")
    .select(MATCH_COLS)
    .or(`player_a.eq.${profileId},player_b.eq.${profileId}`)
    .in("status", [...OPEN_STATUSES])
    .neq("id", excludeId)
    .limit(1)
    .maybeSingle();
  return (data as MatchRow | null) ?? null;
}

export async function joinLobby(me: ArenaIdentity, stakeUsd: number): Promise<{ matchId: string | null; queued: boolean }> {
  const db = supabaseAdmin();
  const open = await openMatchFor(me.profileId);
  if (open) return { matchId: open.id, queued: false };

  // Free stake on-chain? (balance minus anything already pending withdrawal is already deducted)
  const [bal, pending] = await Promise.all([arenaBalance(me.eoa), arenaPendingWithdraw(me.eoa)]);
  if (pending.amount > 0n) throw new ArenaError("Tienes un retiro en curso. Cancélalo para jugar.", 409);
  const owed = await unsettledOwed(me.eoa);
  if (bal - owed < toUnits(stakeUsd)) throw new ArenaError(owed > 0n ? "Tu saldo libre no alcanza: hay una partida por liquidar." : "Fondea tu arena primero.", 402);
  const limits = await arenaLimits();
  if (toUnits(stakeUsd) < limits.min || toUnits(stakeUsd) > limits.max) throw new ArenaError("Monto fuera de los límites de la arena.");

  const matchId = newMatchId();
  const deadline = new Date(Date.now() + MATCH_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await db.rpc("arena_pair", { p_profile: me.profileId, p_eoa: me.eoa, p_stake: stakeUsd, p_match_id: matchId, p_deadline: deadline });
  if (error) {
    console.error("[arena] arena_pair", error.message);
    throw new ArenaError("No se pudo entrar al lobby", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { matched: boolean; match_id: string | null } | undefined;
  if (row?.matched && row.match_id) {
    // the pairing function created the row; stamp best_of (default in schema) — nothing else to do
    return { matchId: row.match_id, queued: false };
  }
  return { matchId: null, queued: true };
}

export async function leaveLobby(profileId: string) {
  await supabaseAdmin().from("arena_lobby").delete().eq("profile_id", profileId);
}

export async function lobbyStatus(profileId: string): Promise<{ queued: boolean; waiting: number }> {
  const db = supabaseAdmin();
  const [{ data: mine }, { count }] = await Promise.all([
    db.from("arena_lobby").select("profile_id").eq("profile_id", profileId).gt("expires_at", nowIso()).maybeSingle(),
    db.from("arena_lobby").select("profile_id", { count: "exact", head: true }).gt("expires_at", nowIso()),
  ]);
  return { queued: !!mine, waiting: count ?? 0 };
}

/** ------------------------------------------------------------ match */

export interface MatchPlayers {
  a: { handle: string; avatar: string };
  b: { handle: string; avatar: string };
}

export async function loadMatch(id: string): Promise<{ match: MatchRow; rounds: RoundRow[]; players?: MatchPlayers; balances?: { a: number; b: number } } | null> {
  const db = supabaseAdmin();
  const { data: m } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).maybeSingle();
  if (!m) return null;
  const row = m as MatchRow;
  const [{ data: rounds }, { data: profs }] = await Promise.all([
    db.from("arena_rounds").select("*").eq("match_id", id).order("round"),
    db.from("profiles").select("id, handle, avatar").in("id", [row.player_a, row.player_b]),
  ]);
  const pick = (pid: string) => {
    const p = (profs ?? []).find((x) => x.id === pid);
    return { handle: (p?.handle as string) ?? "?", avatar: ((p?.avatar as string) || (p?.handle as string)) ?? "?" };
  };
  let balances: { a: number; b: number } | undefined;
  if (["finished", "ready", "settled", "disputed"].includes(row.status)) {
    try {
      const [ba, bb] = await Promise.all([arenaBalance(row.eoa_a as Hex), arenaBalance(row.eoa_b as Hex)]);
      balances = { a: fromUnits(ba), b: fromUnits(bb) };
    } catch {
      /* RPC hiccup: UI just won't gate on it */
    }
  }
  return { match: row, rounds: (rounds ?? []) as RoundRow[], players: { a: pick(row.player_a), b: pick(row.player_b) }, balances };
}

function sideOf(m: MatchRow, me: ArenaIdentity): Side {
  if (m.player_a === me.profileId) return "a";
  if (m.player_b === me.profileId) return "b";
  throw new ArenaError("No juegas en esta partida", 403);
}

export async function applyMatchSig(id: string, me: ArenaIdentity, sig: Hex) {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) throw new ArenaError("Partida no existe", 404);
  const m = loaded.match;
  const side = sideOf(m, me);
  if (m.status !== "signing") return m;
  const ok = await verifyMatchSig(toMatchStruct(m), me.eoa, sig);
  if (!ok) throw new ArenaError("Firma inválida");
  const col = side === "a" ? "sig_a" : "sig_b";
  await db.from("arena_matches").update({ [col]: sig }).eq("id", id).is(col, null);
  // both signed? → start round 1
  const { data: fresh } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const f = fresh as MatchRow;
  if (f.sig_a && f.sig_b && f.status === "signing") {
    // Balances are not locked on-chain (zero gas per match), so re-check BOTH players
    // right before play starts. Anyone short → cancel, nothing at stake yet.
    const [balA, balB, pendA, pendB] = await Promise.all([
      arenaBalance(f.eoa_a as Hex),
      arenaBalance(f.eoa_b as Hex),
      arenaPendingWithdraw(f.eoa_a as Hex),
      arenaPendingWithdraw(f.eoa_b as Hex),
    ]);
    const need = toUnits(Number(f.stake));
    const [owedA, owedB] = await Promise.all([unsettledOwed(f.eoa_a, f.id), unsettledOwed(f.eoa_b, f.id)]);
    if (balA < need + owedA || balB < need + owedB || pendA.amount > 0n || pendB.amount > 0n) {
      await db.from("arena_matches").update({ status: "cancelled", settle_error: "stake no disponible al iniciar" }).eq("id", id).eq("status", "signing");
      return (await loadMatch(id))!.match;
    }
    const { data: started } = await db
      .from("arena_matches")
      .update({ status: "playing", round: 1, started_at: nowIso() })
      .eq("id", id)
      .eq("status", "signing")
      .select("id");
    if (started?.length) await openRound(id, 1);
  }
  return (await loadMatch(id))!.match;
}

async function openRound(matchId: string, round: number) {
  await supabaseAdmin()
    .from("arena_rounds")
    .upsert({ match_id: matchId, round, opened_at: nowIso(), commit_deadline: plus(COMMIT_SECONDS) }, { onConflict: "match_id,round", ignoreDuplicates: true });
}

export async function applyCommit(id: string, me: ArenaIdentity, round: number, hash: Hex, sig: Hex) {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) throw new ArenaError("Partida no existe", 404);
  const m = loaded.match;
  const side = sideOf(m, me);
  if (m.status !== "playing") throw new ArenaError("La partida no está en juego", 409);
  if (round !== m.round) throw new ArenaError("Ronda incorrecta", 409);
  const r = loaded.rounds.find((x) => x.round === round);
  if (!r) throw new ArenaError("Ronda no abierta", 409);
  if (r.outcome) throw new ArenaError("Ronda ya resuelta", 409);
  if (past(r.commit_deadline)) {
    await tick(id);
    throw new ArenaError("Se acabó el tiempo", 409);
  }
  const ok = await verifyCommitSig(id as Hex, round, hash, me.eoa, sig);
  if (!ok) throw new ArenaError("Firma inválida");
  // operator ack = "arrived in time"; without it the chain ignores this commit
  const ack = await signCommitAck(id as Hex, round, me.eoa, hash);
  const patch =
    side === "a"
      ? { commit_a: hash, commit_sig_a: sig, commit_ack_a: ack, committed_a_at: nowIso() }
      : { commit_b: hash, commit_sig_b: sig, commit_ack_b: ack, committed_b_at: nowIso() };
  await db.from("arena_rounds").update(patch).eq("match_id", id).eq("round", round).is(side === "a" ? "commit_a" : "commit_b", null);
  // both committed → open the reveal window
  const { data: fresh } = await db.from("arena_rounds").select("*").eq("match_id", id).eq("round", round).single();
  const fr = fresh as RoundRow;
  if (fr.commit_a && fr.commit_b && !fr.reveal_deadline) {
    await db.from("arena_rounds").update({ reveal_deadline: plus(REVEAL_SECONDS) }).eq("match_id", id).eq("round", round).is("reveal_deadline", null);
  }
  return loadMatch(id);
}

export async function applyReveal(id: string, me: ArenaIdentity, round: number, move: Move, salt: Hex) {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) throw new ArenaError("Partida no existe", 404);
  const m = loaded.match;
  const side = sideOf(m, me);
  if (m.status !== "playing" || round !== m.round) throw new ArenaError("Ronda incorrecta", 409);
  const r = loaded.rounds.find((x) => x.round === round);
  if (!r || r.outcome) throw new ArenaError("Ronda no disponible", 409);
  if (!r.commit_a || !r.commit_b) throw new ArenaError("Espera a que ambos elijan", 409);
  const myCommit = side === "a" ? r.commit_a : r.commit_b;
  if (commitHash(id as Hex, round, me.eoa, move, salt).toLowerCase() !== myCommit.toLowerCase()) throw new ArenaError("La jugada no coincide con tu compromiso");
  if (past(r.reveal_deadline)) {
    await tick(id);
    throw new ArenaError("Se acabó el tiempo", 409);
  }
  const ack = await signRevealAck(id as Hex, round, me.eoa, move, salt);
  await db.from("arena_round_secrets").upsert({ match_id: id, round, side, move, salt, ack }, { onConflict: "match_id,round,side", ignoreDuplicates: true });
  await resolveIfBothRevealed(id, round);
  return loadMatch(id);
}

async function resolveIfBothRevealed(id: string, round: number) {
  const db = supabaseAdmin();
  const { data: secrets } = await db.from("arena_round_secrets").select("side, move, salt, ack").eq("match_id", id).eq("round", round);
  const a = secrets?.find((s) => s.side === "a");
  const b = secrets?.find((s) => s.side === "b");
  if (!a || !b) return;
  const ma = a.move as Move;
  const mb = b.move as Move;
  const outcome: "a" | "b" | "tie" = beats(ma, mb) ? "a" : beats(mb, ma) ? "b" : "tie";
  await settleRound(id, round, outcome, {
    move_a: ma,
    salt_a: a.salt as string,
    reveal_ack_a: a.ack as string,
    move_b: mb,
    salt_b: b.salt as string,
    reveal_ack_b: b.ack as string,
  });
}

/** Writes the round outcome (guarded against double resolution) and advances the match. */
async function settleRound(id: string, round: number, outcome: "a" | "b" | "tie", reveals: Partial<RoundRow> = {}) {
  const db = supabaseAdmin();
  const { data: done } = await db
    .from("arena_rounds")
    .update({ outcome, resolved_at: nowIso(), ...reveals })
    .eq("match_id", id)
    .eq("round", round)
    .is("outcome", null)
    .select("round");
  if (!done?.length) return; // someone else resolved it
  const { data: mrow } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const m = mrow as MatchRow;
  if (m.status !== "playing") return;
  const scoreA = m.score_a + (outcome === "a" ? 1 : 0);
  const scoreB = m.score_b + (outcome === "b" ? 1 : 0);
  const need = Math.floor(m.best_of / 2) + 1;
  const maxRounds = 15;
  const complete = scoreA >= need || scoreB >= need; // decided by score through revealed rounds → settles instantly
  const finished = complete || round >= maxRounds || past(m.deadline);
  if (finished) {
    const winner = scoreA > scoreB ? m.eoa_a : scoreB > scoreA ? m.eoa_b : null;
    await db
      .from("arena_matches")
      .update({ score_a: scoreA, score_b: scoreB, status: complete ? "ready" : "finished", winner_eoa: winner, finished_at: nowIso() })
      .eq("id", id)
      .eq("status", "playing");
    // don't wait for the cron: settle on-chain right away. `after` keeps the function alive past the
    // response (a frozen instance would otherwise orphan the settle lease for its whole TTL).
    if (complete) after(() => settleReady().catch((e) => console.error("[arena] instant settle", e instanceof Error ? e.message : e)));
  } else {
    await db.from("arena_matches").update({ score_a: scoreA, score_b: scoreB, round: round + 1 }).eq("id", id).eq("status", "playing");
    await openRound(id, round + 1);
  }
}

/** Timeouts — the contract's replay rules, applied live. Called by clients when a timer hits zero and by the cron sweep. */
export async function tick(id: string) {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) return null;
  const m = loaded.match;
  if (m.status === "signing") {
    // one side never signed → cancel (nothing was ever at stake)
    if (Date.now() - new Date(m.created_at).getTime() > SIGN_SECONDS * 1000) {
      await db.from("arena_matches").update({ status: "cancelled" }).eq("id", id).eq("status", "signing");
    }
    return loadMatch(id);
  }
  if (m.status !== "playing") return loaded;
  const r = loaded.rounds.find((x) => x.round === m.round);
  if (!r || r.outcome) return loaded;
  if (r.commit_a && r.commit_b) {
    if (past(r.reveal_deadline)) {
      const { data: secrets } = await db.from("arena_round_secrets").select("side, move, salt, ack").eq("match_id", id).eq("round", m.round);
      const a = secrets?.find((s) => s.side === "a");
      const b = secrets?.find((s) => s.side === "b");
      if (a && b) await resolveIfBothRevealed(id, m.round);
      else if (a || b) {
        // one revealed, the other did not → the revealer takes the ROUND (contract rule)
        const reveals: Partial<RoundRow> = a
          ? { move_a: a.move, salt_a: a.salt, reveal_ack_a: a.ack }
          : { move_b: b!.move, salt_b: b!.salt, reveal_ack_b: b!.ack };
        await settleRound(id, m.round, a ? "a" : "b", reveals);
      } else {
        await settleRound(id, m.round, "tie"); // neither revealed → tie round, play on
      }
    }
  } else if (past(r.commit_deadline)) {
    // missing commit → the player who played takes the round; nobody played → tie round
    await settleRound(id, m.round, r.commit_a ? "a" : r.commit_b ? "b" : "tie");
  }
  return loadMatch(id);
}

/** ------------------------------------------------------------ doble o nada */

const REMATCH_WINDOW_SECONDS = 10;
const REMATCH_GRACE_MS = 3 * 60_000; // how long after a match ends a rematch may be opened

/**
 * Either player taps "Doble o nada" → opens a 10s window (first tap sets the clock).
 * When both have tapped inside it, the next match is created: same players, double
 * stake (capped by the Arena max), fresh signatures. Balances are re-checked including
 * what the previous match will still take once it settles.
 */
export async function proposeRematch(id: string, me: ArenaIdentity): Promise<MatchRow> {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) throw new ArenaError("Partida no existe", 404);
  const m = loaded.match;
  const side = sideOf(m, me);
  if (!["finished", "ready", "settled", "disputed"].includes(m.status)) throw new ArenaError("La partida no ha terminado", 409);
  if (m.rematch_id) return m; // already created
  const endedAt = new Date(m.finished_at ?? m.created_at).getTime();
  if (Date.now() - endedAt > REMATCH_GRACE_MS) throw new ArenaError("Ya pasó el momento. Busca otro rival.", 409);
  const GRACE_MS = 2000; // network latency between the rival's tap and our clock
  if (m.rematch_expires_at && new Date(m.rematch_expires_at).getTime() + GRACE_MS <= Date.now()) throw new ArenaError("Se acabó el tiempo.", 409);

  const col = side === "a" ? "rematch_a_at" : "rematch_b_at";
  const patch: Record<string, string> = { [col]: nowIso() };
  if (!m.rematch_expires_at) patch.rematch_expires_at = plus(REMATCH_WINDOW_SECONDS);
  await db.from("arena_matches").update(patch).eq("id", id).is(col, null);

  const { data: fresh } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const f = fresh as MatchRow;
  if (!(f.rematch_a_at && f.rematch_b_at) || f.rematch_id) return f;
  if (f.rematch_expires_at && new Date(f.rematch_b_at > f.rematch_a_at ? f.rematch_b_at : f.rematch_a_at).getTime() > new Date(f.rematch_expires_at).getTime() + GRACE_MS) {
    throw new ArenaError("Se acabó el tiempo.", 409);
  }
  // Both are in. If the previous match hasn't settled yet, settle it now (a few seconds)
  // so the loser's stake isn't counted twice in the exposure check below.
  if (f.status === "ready") {
    try {
      await settleReady();
    } catch (e) {
      console.error("[arena] pre-rematch settle", e instanceof Error ? e.message : e);
    }
  }

  // both in → create the next match (guard with the rematch_id column so only one gets created)
  // "Doble o nada" = the same stake again (win it back, or lose it again)
  const prev = toUnits(Number(f.stake));
  const next = prev;
  const [balA, balB, pendA, pendB] = await Promise.all([arenaBalance(f.eoa_a as Hex), arenaBalance(f.eoa_b as Hex), arenaPendingWithdraw(f.eoa_a as Hex), arenaPendingWithdraw(f.eoa_b as Hex)]);
  // everything either player still owes from decided-but-unsettled matches (this one included)
  const [owesA, owesB, otherA, otherB] = await Promise.all([unsettledOwed(f.eoa_a), unsettledOwed(f.eoa_b), otherOpenMatch(f.player_a, id), otherOpenMatch(f.player_b, id)]);
  const failWith = async (msg: string, status = 409): Promise<never> => {
    await db.from("arena_matches").update({ rematch_error: msg }).eq("id", id).is("rematch_id", null);
    throw new ArenaError(msg, status);
  };
  if (otherA || otherB) await failWith("Alguien ya está en otra partida.");
  if (pendA.amount > 0n || pendB.amount > 0n) await failWith("Hay un retiro en curso.");
  const shortA = balA < next + owesA;
  const shortB = balB < next + owesB;
  if (shortA || shortB) {
    const who = shortA && shortB ? "Ninguno tiene" : `${shortA ? "El jugador A" : "El jugador B"} no tiene`;
    await failWith(`${who} $${fromUnits(next)} en la arena para la revancha.`, 402);
  }

  const newId = newMatchId();
  const deadline = new Date(Date.now() + MATCH_TTL_MINUTES * 60_000).toISOString();
  await db.from("arena_lobby").delete().in("profile_id", [f.player_a, f.player_b]); // a rematch is a commitment; nobody stays queued
  // Insert the child FIRST (rematch_id has a foreign key to it), then link the parent.
  // The unique index on parent_id makes a simultaneous second tap fail cleanly.
  const { error } = await db.from("arena_matches").insert({
    id: newId,
    player_a: f.player_a,
    player_b: f.player_b,
    eoa_a: f.eoa_a,
    eoa_b: f.eoa_b,
    stake: fromUnits(next),
    best_of: f.best_of,
    deadline,
    parent_id: id,
  });
  if (error) {
    if (error.code === "23505") {
      // the other player's request created it a moment ago → link if needed and return
      const { data: child } = await db.from("arena_matches").select("id").eq("parent_id", id).maybeSingle();
      if (child) await db.from("arena_matches").update({ rematch_id: child.id as string }).eq("id", id).is("rematch_id", null);
      return (await loadMatch(id))!.match;
    }
    console.error("[arena] rematch insert", error.message);
    await failWith("No se pudo crear la revancha", 500);
  }
  const { error: linkErr } = await db.from("arena_matches").update({ rematch_id: newId }).eq("id", id).is("rematch_id", null);
  if (linkErr) console.error("[arena] rematch link", linkErr.message);
  return (await loadMatch(id))!.match;
}

/** ------------------------------------------------------------ settlement */

/**
 * Settle every `ready` match in one batch. One settler at a time across instances (lease): the
 * instant settle at match end and the cron can no longer both send the same batch. Whoever
 * waits out the lease re-reads `ready`, so a batch already sent is not sent twice.
 */
async function settleReady(limit = 25, waitMs = 30_000): Promise<{ sent: number; tx: string | null; error?: string }> {
  try {
    const out = await withJobLock("arena_settle", 170, () => settleReadyLocked(limit), waitMs);
    return out ?? { sent: 0, tx: null, error: "otra liquidación en curso" };
  } catch (e) {
    // A lock-table error is reported through the sweep's alert instead of killing the whole run.
    return { sent: 0, tx: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function settleReadyLocked(limit: number): Promise<{ sent: number; tx: string | null; error?: string }> {
  const db = supabaseAdmin();
  const { data: rows } = await db.from("arena_matches").select(MATCH_COLS).eq("status", "ready").order("finished_at").limit(limit);
  const ready = (rows ?? []) as MatchRow[];
  if (ready.length === 0) return { sent: 0, tx: null };
  const items: SettleItem[] = [];
  for (const m of ready) {
    const ev = await evidenceFor(m);
    items.push({ m: toMatchStruct(m), sigA: m.sig_a as Hex, sigB: m.sig_b as Hex, commits: ev.commits, reveals: ev.reveals });
  }
  const ids = ready.map((m) => m.id);
  try {
    const tx = await sendSettleBatch(items);
    await db.from("arena_settlements").insert({ tx_hash: tx, match_ids: ids, status: "sent" });
    const receipt = await waitForTx(tx);
    const ok = receipt.status === "success";
    await db.from("arena_settlements").update({ status: ok ? "confirmed" : "failed" }).eq("tx_hash", tx);
    if (!ok) {
      await db.from("arena_matches").update({ settle_error: "tx reverted" }).in("id", ids);
      return { sent: 0, tx, error: "reverted" };
    }
    // settleBatch skips bad items silently → trust only the Settled events in the receipt
    const settledIds = new Set(
      parseEventLogs({ abi: arenaAbi, logs: receipt.logs, eventName: "Settled" }).map((l) => (l.args.matchId as string).toLowerCase()),
    );
    const done = ids.filter((i) => settledIds.has(i.toLowerCase()));
    const skipped = ids.filter((i) => !settledIds.has(i.toLowerCase()));
    if (done.length) await db.from("arena_matches").update({ status: "settled", settle_tx: tx, settled_at: nowIso() }).in("id", done).eq("status", "ready");
    // A skipped item usually means ANOTHER run settled it a moment earlier (instant settle +
    // cron overlap). Ask the chain; only a truly unsettled match goes back to the claim path.
    for (const row of ready.filter((r) => skipped.includes(r.id))) {
      if ((await reconcileSettled(row)) === "open") {
        await db.from("arena_matches").update({ settle_error: "omitida on-chain, va por reclamo", status: "finished" }).eq("id", row.id).eq("status", "ready");
      }
    }
    return { sent: done.length, tx, error: skipped.length ? `${skipped.length} omitidas` : undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[arena] settleBatch failed", msg);
    await db.from("arena_matches").update({ settle_error: "error al liquidar, reintentando" }).in("id", ids);
    return { sent: 0, tx: null, error: msg };
  }
}

/** POL floor for the operator EOA before LeChanga gets a Telegram nudge. */
const OPERATOR_GAS_FLOOR_POL = 0.5;

/**
 * Cron sweep: time out stuck matches, then settle what's ready. One sweep at a time across
 * instances (job lease); a second caller skips and the next minute's run picks up the rest.
 */
export async function sweep(): Promise<{ ticked: number; settled: { sent: number; tx: string | null; error?: string }; skipped?: boolean }> {
  try {
    return await sweepLocked();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await alertOps("arena-sweep", msg);
    throw e;
  }
}

async function sweepLocked(): Promise<{ ticked: number; settled: { sent: number; tx: string | null; error?: string }; skipped?: boolean }> {
  // TTL covers the worst case (claim + finalize + settle, each waiting up to 120 s for a receipt) and
  // matches the function's own time limit; the lease is released as soon as the sweep ends anyway.
  const out = await withJobLock("arena_sweep", 300, async () => {
    const db = supabaseAdmin();
    const { data: open } = await db.from("arena_matches").select("id").in("status", ["signing", "playing"]).limit(100);
    let ticked = 0;
    for (const row of open ?? []) {
      await tick(row.id as string);
      ticked++;
    }
    await db.from("arena_lobby").delete().lt("expires_at", nowIso());
    await fileClaims();
    await finalizeClaims();
    // Short wait: if an instant settle holds the lease, the next minute's run takes over instead of blocking.
    const settled = await settleReady(25, 5_000);
    // Awaited: a function may be frozen the moment the response goes out, and a fire-and-forget alert would be lost while its throttle still counted it as sent.
    if (settled.error && !/omitidas|en curso/.test(settled.error)) await alertOps("arena-settle", settled.error);
    try {
      const pol = await operatorGasBalance();
      if (pol < OPERATOR_GAS_FLOOR_POL) await alertOps("arena-gas", `El operador tiene ${pol.toFixed(3)} POL; recarga gas.`, 6 * 3600_000);
    } catch {
      /* a failed read is not worth an alert */
    }
    return { ticked, settled };
  });
  return out ?? { ticked: 0, settled: { sent: 0, tx: null }, skipped: true };
}

/** A finished match whose loser never signed, past Match.deadline → operator files the claim with all evidence. */
async function fileClaims(limit = 5) {
  const db = supabaseAdmin();
  const { data: rows } = await db
    .from("arena_matches")
    .select(MATCH_COLS)
    .eq("status", "finished")
    .lt("deadline", nowIso())
    .is("claim_tx", null)
    .limit(limit);
  for (const row of (rows ?? []) as MatchRow[]) {
    try {
      if ((await reconcileSettled(row)) !== "open") continue;
      const { commits, reveals } = await evidenceFor(row);
      const tx = await sendClaim(toMatchStruct(row), row.sig_a as Hex, row.sig_b as Hex, commits, reveals);
      const receipt = await waitForTx(tx);
      if (receipt.status !== "success") throw new Error("claim reverted");
      await db.from("arena_matches").update({ status: "disputed", claim_tx: tx, settle_error: "reclamo en cadena (24h)" }).eq("id", row.id).eq("status", "finished");
    } catch (e) {
      console.error("[arena] claim failed", row.id, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Reconcile a match the chain says is settled but our DB does not. "settled" only when the Settled
 * event carries this row's players and stake (ids are client-chosen, so matchStatus alone proves
 * nothing); a mismatch is held with an error for manual review.
 */
async function reconcileSettled(row: Pick<MatchRow, "id" | "eoa_a" | "eoa_b" | "stake" | "status" | "finished_at" | "created_at">): Promise<"settled" | "mismatch" | "open"> {
  const db = supabaseAdmin();
  let ev: Awaited<ReturnType<typeof arenaSettledEvent>>;
  try {
    ev = await arenaSettledEvent(row.id as Hex, new Date(row.finished_at ?? row.created_at));
  } catch {
    return "open";
  }
  if (!ev) return "open";
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const ours = same(ev.playerA, row.eoa_a) && same(ev.playerB, row.eoa_b) && ev.stake === toUnits(Number(row.stake));
  if (ours) {
    await db.from("arena_matches").update({ status: "settled", settle_tx: ev.tx, settled_at: nowIso(), settle_error: null }).eq("id", row.id).in("status", ["ready", "finished"]);
    return "settled";
  }
  await db.from("arena_matches").update({ settle_error: "liquidación on-chain con otros jugadores/monto — revisar" }).eq("id", row.id);
  return "mismatch";
}

/** Every player-signed, operator-acked artifact we hold for a match — what the chain replays. */
async function evidenceFor(row: MatchRow): Promise<{ commits: ClaimCommit[]; reveals: ClaimReveal[] }> {
  const db = supabaseAdmin();
  const { data: rounds } = await db.from("arena_rounds").select("*").eq("match_id", row.id).order("round");
  const { data: secrets } = await db.from("arena_round_secrets").select("round, side, move, salt, ack").eq("match_id", row.id);
  const commits: ClaimCommit[] = [];
  const reveals: ClaimReveal[] = [];
  for (const r of (rounds ?? []) as RoundRow[]) {
    if (r.commit_a && r.commit_sig_a && r.commit_ack_a) commits.push({ round: r.round, player: row.eoa_a as Hex, hash: r.commit_a as Hex, sig: r.commit_sig_a as Hex, opSig: r.commit_ack_a as Hex });
    if (r.commit_b && r.commit_sig_b && r.commit_ack_b) commits.push({ round: r.round, player: row.eoa_b as Hex, hash: r.commit_b as Hex, sig: r.commit_sig_b as Hex, opSig: r.commit_ack_b as Hex });
    if (r.move_a && r.salt_a && r.reveal_ack_a) reveals.push({ round: r.round, player: row.eoa_a as Hex, move: r.move_a, salt: r.salt_a as Hex, opSig: r.reveal_ack_a as Hex });
    if (r.move_b && r.salt_b && r.reveal_ack_b) reveals.push({ round: r.round, player: row.eoa_b as Hex, move: r.move_b, salt: r.salt_b as Hex, opSig: r.reveal_ack_b as Hex });
  }
  for (const s of secrets ?? []) {
    const player = (s.side === "a" ? row.eoa_a : row.eoa_b) as Hex;
    if (!reveals.some((x) => x.round === s.round && x.player === player)) {
      reveals.push({ round: s.round as number, player, move: s.move as number, salt: s.salt as Hex, opSig: s.ack as Hex });
    }
  }
  return { commits, reveals };
}

/** Claims past their challenge window → finalize (pays out). */
async function finalizeClaims(limit = 5) {
  const db = supabaseAdmin();
  const { data: rows } = await db.from("arena_matches").select(MATCH_COLS).eq("status", "disputed").limit(limit);
  for (const row of (rows ?? []) as MatchRow[]) {
    try {
      const c = await readClaim(row.id as Hex);
      if (c.finalizeAt === 0n) {
        // no claim on-chain (reorg / stale row) → let fileClaims re-file
        await db.from("arena_matches").update({ status: "finished", claim_tx: null }).eq("id", row.id).eq("status", "disputed");
        continue;
      }
      if (BigInt(Math.floor(Date.now() / 1000)) < c.finalizeAt) continue;
      // The chain must agree with the engine. A different winner means a counter-claim
      // beat ours (or we lost evidence) → hold for human review instead of paying out.
      const onchainWinner = c.winner.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : c.winner.toLowerCase();
      const ours = row.winner_eoa ? row.winner_eoa.toLowerCase() : null;
      if (onchainWinner !== ours) {
        console.error("[arena] claim winner mismatch", row.id, { onchainWinner, ours, claimant: c.claimant });
        await db.from("arena_matches").update({ settle_error: "revisar reclamo" }).eq("id", row.id);
        continue;
      }
      const tx = await sendFinalize(toMatchStruct(row), row.sig_a as Hex, row.sig_b as Hex);
      const receipt = await waitForTx(tx);
      if (receipt.status === "success") {
        const winner = c.winner.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : c.winner.toLowerCase();
        await db.from("arena_matches").update({ status: "settled", settle_tx: tx, settled_at: nowIso(), winner_eoa: winner, settle_error: null }).eq("id", row.id).eq("status", "disputed");
      }
    } catch (e) {
      console.error("[arena] finalize failed", row.id, e instanceof Error ? e.message : e);
    }
  }
}

