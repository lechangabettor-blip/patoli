"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadSdk, setAuthFlag } from "@/lib/sdk";

/** Google OAuth lands here; Magic finishes the login, we send the user on. */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    loadSdk()
      .then(async (s) => {
        if (!s.magic) {
          router.replace("/entrar");
          return;
        }
        await s.magic.oauth2.getRedirectResult();
        setAuthFlag(true);
        const next = sessionStorage.getItem("patoli.next") || "/perfil";
        sessionStorage.removeItem("patoli.next");
        window.location.replace(next); // full reload so WalletProvider hydrates the session
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "No se pudo completar el login"));
  }, [router]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      {err ? (
        <>
          <p className="text-sm text-loss">{err}</p>
          <button onClick={() => router.replace("/entrar")} className="btn-ghost mt-4 px-4 py-2 text-xs">
            Volver a intentar
          </button>
        </>
      ) : (
        <p className="pulse-soft font-display text-sm font-bold uppercase tracking-widest text-accent-soft">Entrando…</p>
      )}
    </main>
  );
}
