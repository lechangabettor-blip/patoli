import { NextRequest, NextResponse, connection } from "next/server";
import { buildHmacSignature } from "@polymarket/builder-signing-sdk";

/**
 * Remote signing for builder attribution. The builder secret never reaches
 * the browser: the CLOB and relayer clients call this route to get the
 * HMAC headers Polymarket expects, then attach them to the user's request.
 */

const isConfigured = () =>
  !!(process.env.POLYMARKET_BUILDER_API_KEY && process.env.POLYMARKET_BUILDER_SECRET && process.env.POLYMARKET_BUILDER_PASSPHRASE);

/** GET → { configured } so the UI can explain when trading isn't available yet. */
export async function GET() {
  await connection(); // request-time: reflects current env, never prerendered
  return NextResponse.json({ configured: isConfigured() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const key = process.env.POLYMARKET_BUILDER_API_KEY;
  const secret = process.env.POLYMARKET_BUILDER_SECRET;
  const passphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE;

  if (!key || !secret || !passphrase) {
    return NextResponse.json({ error: "Builder credentials not configured" }, { status: 503 });
  }

  let payload: { method?: string; path?: string; body?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { method, path, body } = payload;
  if (!method || !path || body === undefined) {
    return NextResponse.json({ error: "Missing method, path or body" }, { status: 400 });
  }

  const timestamp = Date.now().toString();
  const signature = buildHmacSignature(secret, parseInt(timestamp, 10), method, path, body as never);

  return NextResponse.json({
    POLY_BUILDER_SIGNATURE: signature,
    POLY_BUILDER_TIMESTAMP: timestamp,
    POLY_BUILDER_API_KEY: key,
    POLY_BUILDER_PASSPHRASE: passphrase,
  });
}
