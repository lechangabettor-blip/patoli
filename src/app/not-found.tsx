import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="text-6xl">🫥</div>
      <h1 className="mt-3 text-3xl">Aquí no hay nada</h1>
      <p className="mt-2 text-sm text-muted">Esa página no existe o ya se fue.</p>
      <Link href="/" className="btn-accent mt-6 px-6 py-3 text-sm">
        Ir al inicio
      </Link>
    </main>
  );
}
