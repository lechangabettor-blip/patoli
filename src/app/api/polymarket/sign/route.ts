import { NextRequest, NextResponse, connection } from "next/server";
import { buildHmacSignature } from "@polymarket/builder-signing-sdk";
import { bearer, isMagicAdminConfigured, verifyDidToken } from "@/lib/magic-admin";

/**
 * Remote signing for builder attribution on relayer requests (deposit-wallet deploy, approvals,
 * wrap/unwrap, tips, Arena funding, redeem). The HMAC secret never leaves the server: the relayer
 * client POSTs {method, path, body} here and gets the headers Polymarket expects.
 *
 * Only logged-in Patoli users may ask (Magic DID token as Bearer, sent by the SDK's
 * remoteBuilderConfig.token), and only for the relayer's own endpoints. Before 2026-10-28 this
 * route answered anyone, which handed out the builder key + passphrase to the public.
 */

const isConfigured = () =>
  !!(process.env.POLYMARKET_BUILDER_API_KEY && process.env.POLYMARKET_BUILDER_SECRET && process.env.POLYMARKET_BUILDER_PASSPHRASE);

/** Relayer v2 endpoints the client signs (node_modules/@polymarket/builder-relayer-client/dist/endpoints.js). */
const ALLOWED_PATHS = /^\/(nonce|relay-payload|submit|deployed|transaction|transactions)(\?.*)?$/;
const ALLOWED_METHODS = new Set(["GET", "POST"]);

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
  if (!isMagicAdminConfigured()) return NextResponse.json({ error: "auth no configurada" }, { status: 503 });
  // Local validation only (signature + expiry); no Magic network call on this hot path.
  const identity = await verifyDidToken(bearer(request), { withEmail: false });
  if (!identity) return NextResponse.json({ error: "sesión inválida" }, { status: 401, headers: { "Cache-Control": "no-store" } });

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
  const m = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(m) || !ALLOWED_PATHS.test(String(path))) {
    console.warn("[patoli] sign request refused", { eoa: identity.eoa, method: m, path });
    return NextResponse.json({ error: "ruta no permitida" }, { status: 403 });
  }

  const timestamp = Date.now().toString();
  const signature = buildHmacSignature(secret, parseInt(timestamp, 10), m, String(path), body as never);

  return NextResponse.json(
    {
      POLY_BUILDER_SIGNATURE: signature,
      POLY_BUILDER_TIMESTAMP: timestamp,
      POLY_BUILDER_API_KEY: key,
      POLY_BUILDER_PASSPHRASE: passphrase,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
