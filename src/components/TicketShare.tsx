"use client";

import { useRef, useState } from "react";
import { toBlob } from "html-to-image";
import { Download, Share2 } from "lucide-react";
import Ticket, { type TicketData } from "./Ticket";

/** A ticket plus Share / Download. Exports a 3× PNG suited to Stories. */
export default function TicketShare({ data, onDone }: { data: TicketData; onDone?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function render(): Promise<Blob | null> {
    if (!ref.current) return null;
    // Wait a frame so fonts/emoji are painted
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return toBlob(ref.current, { pixelRatio: 3, cacheBust: true, backgroundColor: "transparent" });
  }

  const fileName = `patoli-${data.handle}-${(data.proof ?? "boleto").replace(/^0x/, "").slice(0, 8)}.png`;

  async function share() {
    setNote(null);
    setBusy("share");
    try {
      const blob = await render();
      if (!blob) throw new Error("render");
      const file = new File([blob], fileName, { type: "image/png" });
      const text = `${data.selection} @ ${data.odds.toFixed(2)} · $${data.stake} → $${data.payout.toFixed(2)} · patoli.bet/u/${data.handle}`;
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text });
      } else {
        download(blob);
        setNote("Tu navegador no comparte imágenes; se descargó el boleto.");
      }
    } catch (e) {
      if (!(e instanceof Error && /abort/i.test(e.name))) setNote("No se pudo compartir. Prueba descargar.");
    } finally {
      setBusy(null);
    }
  }

  function download(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function onDownload() {
    setNote(null);
    setBusy("download");
    try {
      const blob = await render();
      if (blob) download(blob);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="-mx-2 flex justify-center overflow-hidden py-1">
        <div className="origin-top scale-[0.92]">
          <Ticket ref={ref} data={data} />
        </div>
      </div>
      <div className="mt-3 flex w-full gap-2">
        <button onClick={share} disabled={!!busy} className="btn-accent flex flex-1 items-center justify-center gap-2 py-3 text-sm">
          <Share2 className="h-4 w-4" /> {busy === "share" ? "Preparando…" : "Compartir"}
        </button>
        <button onClick={onDownload} disabled={!!busy} className="btn-ghost flex items-center justify-center gap-2 px-4 py-3 font-display text-xs font-bold uppercase">
          <Download className="h-4 w-4" /> PNG
        </button>
      </div>
      {note ? <p className="mt-2 text-center text-xs text-muted">{note}</p> : null}
      {onDone ? (
        <button onClick={onDone} className="mt-3 text-xs text-muted underline-offset-2 hover:underline">
          Listo
        </button>
      ) : null}
    </div>
  );
}
