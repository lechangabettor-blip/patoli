import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = { title: "Términos", description: "Cómo funciona Patoli, qué cobra y qué no hace." };

/**
 * Plain-language terms. Patoli is an interface: the user's money lives in their own Polymarket
 * deposit wallet on Polygon and every bet is a Polymarket order under Polymarket's rules.
 */
export default function TermsPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-md px-5 pb-16" style={{ paddingTop: "calc(16px + var(--safe-t))" }}>
      <Link href="/entrar" className="btn-ghost inline-flex w-fit items-center gap-1 px-3 py-1.5 text-xs">
        <ArrowLeft className="h-3.5 w-3.5" /> Volver
      </Link>
      <h1 className="mt-6 text-3xl">Términos de uso</h1>
      <p className="mt-2 text-xs text-muted-2">Última actualización: 29 de octubre de 2026</p>

      <Section title="Qué es Patoli">
        Patoli es una app social para apostar en deportes y ver los récords de la banda. Las apuestas se ejecutan en
        Polymarket, un mercado de predicción en la red Polygon. Patoli no es casa de apuestas: no fija cuotas, no toma
        la contra de tus apuestas y nunca guarda tu dinero.
      </Section>

      <Section title="Tu cuenta y tu dinero">
        Al entrar con tu correo o Google se crea una wallet que solo tú controlas. Tu saldo vive en tu propia cuenta de
        depósito de Polymarket (una dirección en Polygon). Patoli no tiene acceso a tus fondos ni a tus llaves. Las
        transacciones en blockchain son irreversibles: una apuesta, un retiro o un tip ya enviados no se pueden deshacer.
        Si mandas fondos por otra red que no sea Polygon, se pierden.
      </Section>

      <Section title="Requisitos">
        Debes tener 18 años o más y apostar debe ser legal donde vives. Eres responsable de cumplir las leyes y los
        términos de Polymarket. Patoli puede suspender cuentas que hagan trampa, usen varias identidades o abusen de
        la plataforma.
      </Section>

      <Section title="Comisiones">
        El momio que ves en Patoli ya incluye todas las comisiones: la de Polymarket (varía por mercado y la fija
        Polymarket) y la de Patoli, que hoy es 0.5% del monto de cada apuesta y nunca pasará de 1%. En una orden límite
        la comisión se muestra en una línea aparte antes de confirmar. Los tips entre usuarios no tienen comisión.
      </Section>

      <Section title="Liquidación de apuestas">
        Cada apuesta se resuelve con las reglas del mercado en Polymarket, no con las de Patoli. Una apuesta cuenta como
        ganada o perdida únicamente cuando Polymarket paga. Los partidos anulados o empatados se devuelven según esas
        mismas reglas. Patoli muestra marcadores y precios en vivo como referencia; pueden tener retraso.
      </Section>

      <Section title="Tu récord es público">
        Tu usuario, tus picks, tus resultados, tus Unidades y tu P&L son públicos y verificables en la blockchain. Tus
        depósitos, retiros y tips solo los ves tú. Tu correo nunca se muestra. Usamos Magic para el inicio de sesión y
        no vendemos tus datos.
      </Section>

      <Section title="Batalla">
        Batalla es piedra, papel o tijera entre dos personas con dinero real, en un contrato en Polygon que guarda las
        apuestas de ambos y paga al ganador. No hay casa: Patoli no participa ni cobra comisión por jugar. Patoli
        coordina las jugadas y puede demorar una liquidación, pero no puede inventar un resultado.
      </Section>

      <Section title="Riesgos">
        Apostar implica perder dinero. Las criptomonedas y los contratos inteligentes tienen riesgos técnicos propios.
        Patoli se ofrece tal cual, sin garantías de disponibilidad ni de resultados, y no responde por pérdidas derivadas
        de Polymarket, Polygon, Magic o de errores del usuario. Si apostar deja de ser diversión, para.
      </Section>

      <Section title="Cambios y contacto">
        Podemos actualizar estos términos; la fecha de arriba cambia cuando lo hacemos. Dudas o problemas: escríbenos en
        Telegram, t.me/lechanga.
      </Section>

      <Link href="/" className="btn-accent mt-8 inline-block w-full py-3 text-center text-sm">
        Ir al inicio
      </Link>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-lg">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </section>
  );
}
