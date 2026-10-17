import { NextRequest, NextResponse, connection } from "next/server";
import { sweep } from "@/lib/arena/engine";
import { isOperatorConfigured } from "@/lib/arena/server";

/** Cron / manual: time out stuck matches and settle ready ones on-chain. Same auth as the indexer. */
async function handle(req: NextRequest) {
  await connection();
  const secret = process.env.INDEXER_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const ok =
    (secret && req.headers.get("x-indexer-secret") === secret) ||
    (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) ||
    process.env.NODE_ENV === "development";
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isOperatorConfigured()) return NextResponse.json({ error: "operator no configurado" }, { status: 503 });
  try {
    return NextResponse.json(await sweep());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "sweep failed" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
