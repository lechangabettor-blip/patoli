"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Hex } from "viem";
import { polygon } from "viem/chains";
import Logo from "@/components/Logo";
import { ARENA_ADDRESS, isArenaConfigured } from "@/lib/arena/typed-data";
import { POLYGON_RPC_URL } from "@/lib/polymarket/constants";

/**
 * Owner console for the PatoliArena contract. Talks to the OWNER's own wallet
 * (MetaMask via window.ethereum), never to the app's embedded wallet. Owner powers
 * are deliberately tiny: accept ownership, stake limits, pause new deposits, rotate
 * the operator. No function here can touch player balances.
 */

const abi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function operator() view returns (address)",
  "function minStake() view returns (uint256)",
  "function maxStake() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function acceptOwnership()",
  "function setDepositsPaused(bool)",
]);

interface Eth {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}
declare global {
  interface Window {
    ethereum?: Eth;
  }
}

const pub = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC_URL) });
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export default function ArenaOwnerPage() {
  const [account, setAccount] = useState<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["arena-owner-state"],
    enabled: isArenaConfigured(),
    refetchInterval: 15_000,
    queryFn: async () => {
      const [owner, pending, operator, min, max, paused] = await Promise.all([
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "owner" }),
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "pendingOwner" }),
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "operator" }),
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "minStake" }),
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "maxStake" }),
      pub.readContract({ address: ARENA_ADDRESS, abi, functionName: "depositsPaused" }),
      ]);
      return { owner, pending, operator, min, max, paused };
    },
  });
  const state = q.data ?? null;
  const load = () => q.refetch();

  async function connect() {
    setMsg(null);
    if (!window.ethereum) {
      setMsg("No encuentro MetaMask en este navegador. Abre esta página en el navegador donde tienes MetaMask.");
      return;
    }
    const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    setAccount((accounts[0] ?? null) as Hex | null);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
    } catch {
      setMsg("Cambia MetaMask a la red Polygon y vuelve a intentar.");
    }
  }

  async function write(fn: "acceptOwnership" | "setDepositsPaused", args: unknown[] = []) {
    if (!window.ethereum || !account) return;
    setBusy(true);
    setMsg(null);
    try {
      const wallet = createWalletClient({ account, chain: polygon, transport: custom(window.ethereum) });
      const hash = await wallet.writeContract({ address: ARENA_ADDRESS, abi, functionName: fn, args: args as never });
      setMsg("Enviado. Esperando confirmación…");
      const r = await pub.waitForTransactionReceipt({ hash });
      setMsg(r.status === "success" ? `Listo. tx ${short(hash)}` : "La transacción falló.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.split("\n")[0] : "Error");
    } finally {
      setBusy(false);
    }
  }

  const isPending = !!state && !!account && state.pending.toLowerCase() === account.toLowerCase();
  const isOwner = !!state && !!account && state.owner.toLowerCase() === account.toLowerCase();

  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-16 pt-6">
      <div className="flex items-center gap-2">
        <Logo size={28} word={false} />
        <h1 className="text-xl">Arena · dueño</h1>
      </div>
      <p className="mt-1 text-xs text-muted">Contrato {short(ARENA_ADDRESS)} en Polygon. Esta página usa tu MetaMask, no la wallet de la app.</p>

      <div className="card mt-4 space-y-2 p-4 text-sm">
        <Row k="Dueño actual" v={short(state?.owner)} />
        <Row k="Dueño pendiente" v={short(state?.pending)} />
        <Row k="Operador (servidor)" v={short(state?.operator)} />
        <Row k="Apuesta por jugador" v={state ? `$${Number(state.min) / 1e6} – $${Number(state.max) / 1e6}` : "—"} />
        <Row k="Depósitos" v={state ? (state.paused ? "Pausados" : "Abiertos") : "—"} />
      </div>

      {!account ? (
        <button onClick={connect} className="btn-accent mt-4 w-full py-3 text-sm">
          Conectar MetaMask
        </button>
      ) : (
        <div className="card mt-4 p-4">
          <div className="text-xs text-muted">Conectado como {short(account)}</div>
          {isPending ? (
            <>
              <p className="mt-2 text-sm">Esta wallet es la dueña pendiente. Acepta para tomar el control del contrato.</p>
              <button onClick={() => write("acceptOwnership")} disabled={busy} className="btn-accent mt-3 w-full py-3 text-sm">
                {busy ? "Confirmando…" : "Aceptar propiedad"}
              </button>
            </>
          ) : isOwner ? (
            <>
              <p className="mt-2 text-sm text-win">Eres el dueño.</p>
              <button onClick={() => write("setDepositsPaused", [!state!.paused])} disabled={busy} className="btn-ghost mt-3 w-full py-2.5 text-xs">
                {state!.paused ? "Reabrir depósitos" : "Pausar depósitos nuevos"}
              </button>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">Esta wallet no es dueña ni dueña pendiente. Cambia de cuenta en MetaMask.</p>
          )}
        </div>
      )}
      {msg ? <p className="mt-3 break-words text-xs text-muted">{msg}</p> : null}
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{k}</span>
      <span className="tnum font-semibold">{v}</span>
    </div>
  );
}
