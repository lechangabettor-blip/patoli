"use client";

import Link from "next/link";

/** A crash inside a page shows this instead of a blank app. Funds are never at stake here: they live in the user's wallet. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="text-6xl">🫠</div>
      <h1 className="mt-3 text-3xl">Algo se rompió</h1>
      <p className="mt-2 text-sm text-muted">Fue la app, no tu apuesta. Tu saldo sigue en tu wallet.</p>
      <button onClick={reset} className="btn-accent mt-6 w-full py-3 text-sm">
        Reintentar
      </button>
      <Link href="/" className="mt-4 text-xs text-muted underline underline-offset-2">
        Ir al inicio
      </Link>
      {error.digest ? <p className="tnum mt-8 text-[10px] text-muted-2">ref {error.digest}</p> : null}
    </main>
  );
}
