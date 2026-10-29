"use client";

/** Last resort: the root layout itself failed, so this renders its own html/body. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="es-MX">
      <body style={{ margin: 0, background: "#1f1f29", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ maxWidth: 448, margin: "0 auto", minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 56 }}>🫠</div>
          <h1 style={{ marginTop: 12, fontSize: 28, textTransform: "uppercase" }}>Algo se rompió</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: "#b9b9c7" }}>Fue la app, no tu apuesta. Tu saldo sigue en tu wallet.</p>
          <button onClick={reset} style={{ marginTop: 24, width: "100%", padding: "12px 0", borderRadius: 999, border: 0, background: "#ff3d17", color: "#fff", fontWeight: 700, fontSize: 14 }}>
            Reintentar
          </button>
          {error.digest ? <p style={{ marginTop: 32, fontSize: 10, color: "#8a8a9c" }}>ref {error.digest}</p> : null}
        </main>
      </body>
    </html>
  );
}
