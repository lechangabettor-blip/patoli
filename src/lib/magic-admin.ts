import "server-only";
import { Magic } from "@magic-sdk/admin";

/**
 * Verifies a Magic DID token sent by the browser and returns the identity it
 * proves. Used by every authenticated route. Needs MAGIC_SECRET_KEY (server).
 */
export interface MagicIdentity {
  issuer: string;
  eoa: `0x${string}`;
  email: string | null;
}

let admin: Magic | null = null;

export function isMagicAdminConfigured() {
  return !!process.env.MAGIC_SECRET_KEY;
}

function getAdmin(): Magic {
  if (!process.env.MAGIC_SECRET_KEY) throw new Error("MAGIC_SECRET_KEY no está configurado");
  if (!admin) admin = new Magic(process.env.MAGIC_SECRET_KEY);
  return admin;
}

export async function verifyDidToken(didToken: string | null | undefined): Promise<MagicIdentity | null> {
  if (!didToken) return null;
  try {
    const m = getAdmin();
    m.token.validate(didToken);
    const issuer = m.token.getIssuer(didToken);
    const eoa = m.token.getPublicAddress(didToken).toLowerCase() as `0x${string}`;
    let email: string | null = null;
    try {
      const meta = await m.users.getMetadataByIssuer(issuer);
      email = meta.email ?? null;
    } catch {
      /* metadata is optional */
    }
    return { issuer, eoa, email };
  } catch {
    return null;
  }
}

/** Pull the bearer token from a request. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}
