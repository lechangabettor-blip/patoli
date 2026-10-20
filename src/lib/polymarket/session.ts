/**
 * Local trading session: the user's CLOB API credentials and the state of
 * their deposit wallet (deployed / approvals). Stored per EOA in localStorage.
 * Credentials are L2 keys derived from the user's own signature; they never
 * touch our server.
 */
export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export const SESSION_VERSION = 2; // 1 = Safe era (deprecated by Polymarket), 2 = deposit wallet

export interface TradingSession {
  version: number;
  eoaAddress: string;
  /** Deposit wallet (the maker/funder for orders) */
  walletAddress: string;
  isDeployed: boolean;
  hasApprovals: boolean;
  apiCredentials?: ApiCreds;
  updatedAt: number;
}

export type SessionStep = "idle" | "checking" | "deploying" | "credentials" | "approvals" | "complete";

export const SESSION_STEP_LABEL: Record<SessionStep, string> = {
  idle: "",
  checking: "Revisando tu cuenta…",
  deploying: "Creando tu bóveda en Polygon…",
  credentials: "Firmando tus llaves de trading…",
  approvals: "Activando permisos (una sola vez)…",
  complete: "Listo",
};

const key = (eoa: string) => `patoli.session.${eoa.toLowerCase()}`;

export function loadSession(eoa: string): TradingSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(eoa));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<TradingSession>;
    if (s.eoaAddress?.toLowerCase() !== eoa.toLowerCase()) return null;
    if ((s.version ?? 1) < SESSION_VERSION) return null; // pre-deposit-wallet session: activate again
    return s as TradingSession;
  } catch {
    return null;
  }
}

export function saveSession(s: TradingSession) {
  try {
    localStorage.setItem(key(s.eoaAddress), JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}

export function clearSession(eoa: string) {
  try {
    localStorage.removeItem(key(eoa));
  } catch {
    /* ignore */
  }
}
