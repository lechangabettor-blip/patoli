import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

/**
 * Lease lock in Postgres (`job_locks`, migration 0012) so a job runs on ONE instance at a time.
 * On Vercel the per-minute cron, a user's post-bet sync and an instant Arena settle can all fire
 * at once, each on its own instance; before this they could settle or send twice. A lease (row +
 * expiry) survives connection pooling, which Postgres advisory locks do not through PostgREST.
 *
 * Until the migration is applied the functions do not exist (PostgREST code PGRST202): we log,
 * run unlocked as before, and probe again five minutes later, so the lock engages on every warm
 * instance shortly after the SQL lands. Any other error fails the job (fail closed: never risk
 * two operator sends because the lock table hiccupped).
 */
const RECHECK_MS = 5 * 60_000;
let missingUntil = 0;

/**
 * Run `fn` holding the lease `name` for at most `ttlSeconds`. Waits up to `waitMs` for a busy
 * lease (0 = give up at once). Resolves `undefined` when the lease could not be taken.
 */
export async function withJobLock<T>(name: string, ttlSeconds: number, fn: () => Promise<T>, waitMs = 0): Promise<T | undefined> {
  const db = supabaseAdmin();
  const holder = randomUUID();
  const deadline = Date.now() + waitMs;
  let held = false;
  while (Date.now() >= missingUntil) {
    const { data, error } = await db.rpc("acquire_job_lock", { p_name: name, p_ttl_seconds: ttlSeconds, p_holder: holder });
    if (error) {
      if (error.code === "PGRST202") {
        missingUntil = Date.now() + RECHECK_MS;
        console.warn("[patoli] job_locks not installed yet (migration 0012): running without a lock, re-checking in 5 min");
        break;
      }
      throw new Error(`job lock ${name}: ${error.message}`);
    }
    if (data === true) {
      held = true;
      break;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 400));
  }
  try {
    return await fn();
  } finally {
    if (held) await db.rpc("release_job_lock", { p_name: name, p_holder: holder });
  }
}
