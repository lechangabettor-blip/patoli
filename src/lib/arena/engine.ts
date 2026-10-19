import "server-only";
import { randomBytes } from "crypto";
import type { Hex } from "viem";
import { supabaseAdmin } from "@/lib/supabase/server";
import { parseEventLogs } from "viem";
import { arenaAbi } from "./abi";
import {
  arenaBalance,
  arenaLimits,
  arenaPendingWithdraw,
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
  BEST_OF,
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
 * forfeits the match; a round where nobody commits/reveals ends the match on
 * score (tie → draw). Nobody signs a result: a match completed by score becomes
 * `ready` and the cron settles it on-chain from the moves themselves; forfeits and
 * abandoned matches go through the on-chain claim (24h window) filed by the operator.
 */

export type Side = "a" | "b";
/** Statuses that keep a player's stake committed (no new match, no relayed withdrawal). */
export const OPEN_STATUSES = ["signing", "playing", "finished", "ready", "disputed"] as const;

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

const MATCH_COLS = "id, player_a, player_b, eoa_a, eoa_b, stake, best_of, deadline, status, sig_a, sig_b, round, score_a, score_b, winner_eoa, settle_tx, claim_tx, rematch_a_at, rematch_b_at, rematch_expires_at, rematch_id, parent_id, created_at, started_at, finished_at";
const nowIso = () => new Date().toISOString();
const plus = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const past = (iso: string | null) => !!iso && new Date(iso).getTime() <= Date.now();

export const newMatchId = (): Hex => `0x${randomBytes(32).toString("hex")}`;

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
export async function otherOpenMatch(profileId: string, excludeId: string): Promise<MatchRow | null> {
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
  if (bal < toUnits(stakeUsd)) throw new ArenaError("Fondea tu arena primero.", 402);
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

export async function loadMatch(id: string): Promise<{ match: MatchRow; rounds: RoundRow[]; players?: MatchPlayers } | null> {
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
  return { match: row, rounds: (rounds ?? []) as RoundRow[], players: { a: pick(row.player_a), b: pick(row.player_b) } };
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
  } else {
    await db.from("arena_matches").update({ score_a: scoreA, score_b: scoreB, round: round + 1 }).eq("id", id).eq("status", "playing");
    await openRound(id, round + 1);
  }
}

/** Ends a match now. winnerSide null = decide on score (tie → draw). */
async function finishMatch(id: string, winnerSide: Side | null, reason: string) {
  const db = supabaseAdmin();
  const { data: mrow } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const m = mrow as MatchRow;
  if (m.status !== "playing") return;
  const winner = winnerSide === "a" ? m.eoa_a : winnerSide === "b" ? m.eoa_b : m.score_a > m.score_b ? m.eoa_a : m.score_b > m.score_a ? m.eoa_b : null;
  await db
    .from("arena_matches")
    .update({ status: "finished", winner_eoa: winner, finished_at: nowIso(), settle_error: reason })
    .eq("id", id)
    .eq("status", "playing");
  // close the open round for the record
  await db.from("arena_rounds").update({ outcome: winnerSide ?? "tie", resolved_at: nowIso() }).eq("match_id", id).eq("round", m.round).is("outcome", null);
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
        // one revealed, the other did not → non-revealer forfeits the match (contract rule)
        const reveals: Partial<RoundRow> = a
          ? { move_a: a.move, salt_a: a.salt, reveal_ack_a: a.ack }
          : { move_b: b!.move, salt_b: b!.salt, reveal_ack_b: b!.ack };
        await db.from("arena_rounds").update(reveals).eq("match_id", id).eq("round", m.round);
        await finishMatch(id, a ? "a" : "b", "rival no reveló");
      } else {
        await finishMatch(id, null, "nadie reveló"); // neither revealed → match ends on score
      }
    }
  } else if (past(r.commit_deadline)) {
    if (r.commit_a || r.commit_b) await finishMatch(id, r.commit_a ? "a" : "b", "rival no jugó"); // missing commit → forfeit
    else await finishMatch(id, null, "nadie jugó"); // nobody committed → ends on score
  }
  return loadMatch(id);
}

/** ------------------------------------------------------------ doble o nada */

export const REMATCH_WINDOW_SECONDS = 10;
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
  if (m.rematch_expires_at && past(m.rematch_expires_at)) throw new ArenaError("Se acabó el tiempo.", 409);

  const col = side === "a" ? "rematch_a_at" : "rematch_b_at";
  const patch: Record<string, string> = { [col]: nowIso() };
  if (!m.rematch_expires_at) patch.rematch_expires_at = plus(REMATCH_WINDOW_SECONDS);
  await db.from("arena_matches").update(patch).eq("id", id).is(col, null);

  const { data: fresh } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const f = fresh as MatchRow;
  if (!(f.rematch_a_at && f.rematch_b_at) || f.rematch_id) return f;
  if (f.rematch_expires_at && new Date(f.rematch_b_at > f.rematch_a_at ? f.rematch_b_at : f.rematch_a_at).getTime() > new Date(f.rematch_expires_at).getTime()) {
    throw new ArenaError("Se acabó el tiempo.", 409);
  }

  // both in → create the next match (guard with the rematch_id column so only one gets created)
  const limits = await arenaLimits();
  const prev = toUnits(Number(f.stake));
  let next = prev * 2n;
  if (next > limits.max) next = limits.max;
  const [balA, balB, pendA, pendB] = await Promise.all([arenaBalance(f.eoa_a as Hex), arenaBalance(f.eoa_b as Hex), arenaPendingWithdraw(f.eoa_a as Hex), arenaPendingWithdraw(f.eoa_b as Hex)]);
  // everything either player still owes from decided-but-unsettled matches (this one included)
  const [owesA, owesB, otherA, otherB] = await Promise.all([unsettledOwed(f.eoa_a), unsettledOwed(f.eoa_b), otherOpenMatch(f.player_a, id), otherOpenMatch(f.player_b, id)]);
  if (otherA || otherB) throw new ArenaError("Alguien ya está en otra partida.", 409);
  if (pendA.amount > 0n || pendB.amount > 0n) throw new ArenaError("Hay un retiro en curso.", 409);
  if (balA < next + owesA || balB < next + owesB) throw new ArenaError(`Alguien no tiene $${fromUnits(next)} en su arena.`, 402);

  const newId = newMatchId();
  const deadline = new Date(Date.now() + MATCH_TTL_MINUTES * 60_000).toISOString();
  await db.from("arena_lobby").delete().in("profile_id", [f.player_a, f.player_b]); // a rematch is a commitment; nobody stays queued
  const { data: claimed } = await db.from("arena_matches").update({ rematch_id: newId }).eq("id", id).is("rematch_id", null).select("id");
  if (!claimed?.length) return (await loadMatch(id))!.match; // the other request won the race
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
    console.error("[arena] rematch insert", error.message);
    await db.from("arena_matches").update({ rematch_id: null }).eq("id", id);
    throw new ArenaError("No se pudo crear la revancha", 500);
  }
  return (await loadMatch(id))!.match;
}

/** ------------------------------------------------------------ settlement */

export async function settleReady(limit = 25): Promise<{ sent: number; tx: string | null; error?: string }> {
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
    // skipped on-chain (bad sig / already settled) → back to 'finished' so the claim path picks it up after the deadline
    if (skipped.length) await db.from("arena_matches").update({ settle_error: "omitida on-chain, va por reclamo", status: "finished" }).in("id", skipped).eq("status", "ready");
    return { sent: done.length, tx, error: skipped.length ? `${skipped.length} omitidas` : undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[arena] settleBatch failed", msg);
    await db.from("arena_matches").update({ settle_error: "error al liquidar, reintentando" }).in("id", ids);
    return { sent: 0, tx: null, error: msg };
  }
}

/** Cron sweep: time out stuck matches, then settle what's ready. */
export async function sweep(): Promise<{ ticked: number; settled: { sent: number; tx: string | null; error?: string } }> {
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
  const settled = await settleReady();
  return { ticked, settled };
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

export { BEST_OF };
