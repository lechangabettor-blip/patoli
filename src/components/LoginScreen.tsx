"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useWallet } from "@/providers/WalletContext";

export default function LoginScreen() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get("next") || "/perfil";
  const { status, loginWithEmail, loginWithGoogle, isDemo } = useWallet();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);

  useEffect(() => {
    if (status === "connected") router.replace(next);
  }, [status, next, router]);

  async function withEmail(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy("email");
    try {
      await loginWithEmail(email.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo iniciar sesión");
    } finally {
      setBusy(null);
    }
  }

  async function withGoogle() {
    setErr(null);
    setBusy("google");
    try {
      sessionStorage.setItem("patoli.next", next);
      await loginWithGoogle();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo iniciar sesión");
      setBusy(null);
    }
  }

  const valid = /.+@.+\..+/.test(email) && agree;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-4">
      <Link href="/" className="btn-ghost inline-flex w-fit items-center gap-1 px-3 py-1.5 text-xs">
        <ArrowLeft className="h-3.5 w-3.5" /> Volver
      </Link>

      <div className="mt-10">
        <div className="font-display text-5xl font-extrabold uppercase tracking-tight text-accent">Patoli</div>
        <h1 className="mt-3 text-3xl">
          Cualquiera opina.
          <br />
          Nosotros <span className="text-accent">apostamos.</span>
        </h1>
        <p className="mt-3 max-w-[32ch] text-sm text-muted">Crea tu cuenta con tu correo. Tu wallet se crea sola; nunca ves frases raras ni pagas gas.</p>
      </div>

      <form onSubmit={withEmail} className="mt-8 space-y-3">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="tu@correo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-2xl border border-hairline bg-surface px-4 py-3.5 text-base outline-none placeholder:text-muted-2 focus:border-accent"
        />
        <label className="flex items-start gap-2 text-xs text-muted">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
          <span>
            Tengo 18 años o más y acepto los{" "}
            <Link href="/terminos" className="text-accent-soft underline">
              términos
            </Link>
            . Las apuestas se liquidan con las reglas de Polymarket.
          </span>
        </label>
        <button type="submit" disabled={!valid || !!busy || isDemo} className="btn-accent w-full py-3.5 text-sm">
          {busy === "email" ? "Revisa tu correo…" : "Continuar con correo"}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-muted-2">
        <span className="h-px flex-1 bg-hairline" /> o <span className="h-px flex-1 bg-hairline" />
      </div>

      <button onClick={withGoogle} disabled={!agree || !!busy || isDemo} className="btn-ghost flex w-full items-center justify-center gap-2 py-3.5 text-sm font-semibold">
        <GoogleG /> {busy === "google" ? "Abriendo Google…" : "Continuar con Google"}
      </button>

      {err ? <p className="mt-4 text-center text-xs text-loss">{err}</p> : null}
      {isDemo ? <p className="mt-4 text-center text-[11px] text-muted-2">Modo demo: el login se activa al configurar NEXT_PUBLIC_MAGIC_API_KEY.</p> : null}

      <p className="mt-auto pt-10 text-center text-[11px] text-muted-2">Juego responsable. Si apostar deja de ser diversión, para.</p>
    </main>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C41 35.4 44 30.2 44 24c0-1.3-.1-2.3-.4-3.5z" />
    </svg>
  );
}
