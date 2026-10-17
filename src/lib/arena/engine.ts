import "server-only";
import { randomBytes } from "crypto";
import type { Hex } from "viem";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  arenaBalance,
  arenaPendingWithdraw,
  sendSettleBatch,
  verifyCommitSig,
  verifyMatchSig,
  verifyResultSig,
  waitForTx,
  type ArenaIdentity,
  type SettleItem,
} from "./server";
import {
  BEST_OF,
  COMMIT_SECONDS,
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
 * Off-chain leniency vs on-chain rules: on-chain a missing commit/reveal
 * forfeits the MATCH (dispute path). Here, to be kind to flaky phones, a missed
 * commit/reveal only loses the ROUND. Both players still sign the final result,
 * so the lenient outcome is what gets settled; the harsh rule exists only for a
 * player who disappears and refuses to sign.
 */

export type Side = "a" | "b";
export const OPEN_STATUSES = ["signing", "playing", "finished", "ready"] as const;

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
  result_sig_a: string | null;
  result_sig_b: string | null;
  settle_tx: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RoundRow {
  match_id: string;
  round: number;
  commit_a: string | null;
  commit_sig_a: string | null;
  committed_a_at: string | null;
  commit_b: string | null;
  commit_sig_b: string | null;
  committed_b_at: string | null;
  move_a: number | null;
  salt_a: string | null;
  move_b: number | null;
  salt_b: string | null;
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

const MATCH_COLS = "id, player_a, player_b, eoa_a, eoa_b, stake, best_of, deadline, status, sig_a, sig_b, round, score_a, score_b, winner_eoa, result_sig_a, result_sig_b, settle_tx, created_at, started_at, finished_at";
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

export async function joinLobby(me: ArenaIdentity, stakeUsd: number): Promise<{ matchId: string | null; queued: boolean }> {
  const db = supabaseAdmin();
  const open = await openMatchFor(me.profileId);
  if (open) return { matchId: open.id, queued: false };

  // Free stake on-chain? (balance minus anything already pending withdrawal is already deducted)
  const [bal, pending] = await Promise.all([arenaBalance(me.eoa), arenaPendingWithdraw(me.eoa)]);
  if (pending.amount > 0n) throw new ArenaError("Tienes un retiro en curso. Cancélalo para jugar.", 409);
  if (bal < toUnits(stakeUsd)) throw new ArenaError("Fondea tu arena primero.", 402);

  const matchId = newMatchId();
  const deadline = new Date(Date.now() + MATCH_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await db.rpc("arena_pair", { p_profile: me.profileId, p_eoa: me.eoa, p_stake: stakeUsd, p_match_id: matchId, p_deadline: deadline });
  if (error) throw new ArenaError(error.message, 500);
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

export async function loadMatch(id: string): Promise<{ match: MatchRow; rounds: RoundRow[] } | null> {
  const db = supabaseAdmin();
  const { data: m } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).maybeSingle();
  if (!m) return null;
  const { data: rounds } = await db.from("arena_rounds").select("*").eq("match_id", id).order("round");
  return { match: m as MatchRow, rounds: (rounds ?? []) as RoundRow[] };
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
  const patch = side === "a" ? { commit_a: hash, commit_sig_a: sig, committed_a_at: nowIso() } : { commit_b: hash, commit_sig_b: sig, committed_b_at: nowIso() };
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
  await db.from("arena_round_secrets").upsert({ match_id: id, round, side, move, salt }, { onConflict: "match_id,round,side", ignoreDuplicates: true });
  await resolveIfBothRevealed(id, round);
  return loadMatch(id);
}

async function resolveIfBothRevealed(id: string, round: number) {
  const db = supabaseAdmin();
  const { data: secrets } = await db.from("arena_round_secrets").select("side, move, salt").eq("match_id", id).eq("round", round);
  const a = secrets?.find((s) => s.side === "a");
  const b = secrets?.find((s) => s.side === "b");
  if (!a || !b) return;
  const ma = a.move as Move;
  const mb = b.move as Move;
  const outcome: "a" | "b" | "tie" = beats(ma, mb) ? "a" : beats(mb, ma) ? "b" : "tie";
  await settleRound(id, round, outcome, { move_a: ma, salt_a: a.salt as string, move_b: mb, salt_b: b.salt as string });
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
  const finished = scoreA >= need || scoreB >= need || round >= maxRounds || past(m.deadline);
  if (finished) {
    const winner = scoreA > scoreB ? m.eoa_a : scoreB > scoreA ? m.eoa_b : null;
    await db
      .from("arena_matches")
      .update({ score_a: scoreA, score_b: scoreB, status: "finished", winner_eoa: winner, finished_at: nowIso() })
      .eq("id", id)
      .eq("status", "playing");
  } else {
    await db.from("arena_matches").update({ score_a: scoreA, score_b: scoreB, round: round + 1 }).eq("id", id).eq("status", "playing");
    await openRound(id, round + 1);
  }
}

/** Timeouts. Called by clients when their timer hits zero and by the cron sweep. */
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
      const { data: secrets } = await db.from("arena_round_secrets").select("side, move, salt").eq("match_id", id).eq("round", m.round);
      const a = secrets?.find((s) => s.side === "a");
      const b = secrets?.find((s) => s.side === "b");
      if (a && b) await resolveIfBothRevealed(id, m.round);
      else {
        const outcome: "a" | "b" | "tie" = a ? "a" : b ? "b" : "tie";
        const reveals: Partial<RoundRow> = {};
        if (a) Object.assign(reveals, { move_a: a.move, salt_a: a.salt });
        if (b) Object.assign(reveals, { move_b: b.move, salt_b: b.salt });
        await settleRound(id, m.round, outcome, reveals);
      }
    }
  } else if (past(r.commit_deadline)) {
    const outcome: "a" | "b" | "tie" = r.commit_a ? "a" : r.commit_b ? "b" : "tie";
    await settleRound(id, m.round, outcome);
  }
  return loadMatch(id);
}

export async function applyResultSig(id: string, me: ArenaIdentity, sig: Hex) {
  const db = supabaseAdmin();
  const loaded = await loadMatch(id);
  if (!loaded) throw new ArenaError("Partida no existe", 404);
  const m = loaded.match;
  const side = sideOf(m, me);
  if (m.status !== "finished" && m.status !== "ready") throw new ArenaError("La partida no ha terminado", 409);
  const winner = (m.winner_eoa ?? "0x0000000000000000000000000000000000000000") as Hex;
  const ok = await verifyResultSig(id as Hex, winner, me.eoa, sig);
  if (!ok) throw new ArenaError("Firma inválida");
  const col = side === "a" ? "result_sig_a" : "result_sig_b";
  await db.from("arena_matches").update({ [col]: sig }).eq("id", id).is(col, null);
  const { data: fresh } = await db.from("arena_matches").select(MATCH_COLS).eq("id", id).single();
  const f = fresh as MatchRow;
  if (f.result_sig_a && f.result_sig_b && f.status === "finished") {
    await db.from("arena_matches").update({ status: "ready" }).eq("id", id).eq("status", "finished");
  }
  return (await loadMatch(id))!.match;
}

/** ------------------------------------------------------------ settlement */

export async function settleReady(limit = 25): Promise<{ sent: number; tx: string | null; error?: string }> {
  const db = supabaseAdmin();
  const { data: rows } = await db.from("arena_matches").select(MATCH_COLS).eq("status", "ready").order("finished_at").limit(limit);
  const ready = (rows ?? []) as MatchRow[];
  if (ready.length === 0) return { sent: 0, tx: null };
  const items: SettleItem[] = ready.map((m) => ({
    m: toMatchStruct(m),
    sigA: m.sig_a as Hex,
    sigB: m.sig_b as Hex,
    winner: (m.winner_eoa ?? "0x0000000000000000000000000000000000000000") as Hex,
    resSigA: m.result_sig_a as Hex,
    resSigB: m.result_sig_b as Hex,
  }));
  const ids = ready.map((m) => m.id);
  try {
    const tx = await sendSettleBatch(items);
    await db.from("arena_settlements").insert({ tx_hash: tx, match_ids: ids, status: "sent" });
    const receipt = await waitForTx(tx);
    const ok = receipt.status === "success";
    await db.from("arena_settlements").update({ status: ok ? "confirmed" : "failed" }).eq("tx_hash", tx);
    if (ok) await db.from("arena_matches").update({ status: "settled", settle_tx: tx, settled_at: nowIso() }).in("id", ids).eq("status", "ready");
    else await db.from("arena_matches").update({ settle_error: "tx reverted" }).in("id", ids);
    return { sent: ids.length, tx, error: ok ? undefined : "reverted" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("arena_matches").update({ settle_error: msg.slice(0, 300) }).in("id", ids);
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
  // finished matches whose loser never signed within the TTL stay 'finished' → winner can claim on-chain (dispute path)
  await db.from("arena_lobby").delete().lt("expires_at", nowIso());
  const settled = await settleReady();
  return { ticked, settled };
}

export { BEST_OF };
