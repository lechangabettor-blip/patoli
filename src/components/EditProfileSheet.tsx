"use client";

import { useState } from "react";
import Sheet from "./Sheet";
import Avatar from "./Avatar";
import { useMe } from "@/providers/MeProvider";
import { cn } from "@/lib/cn";

const EMOJIS = ["🦧", "🐺", "🎯", "🔥", "🦅", "🐂", "🦈", "👑", "⚡", "🍀", "🎰", "🏆", "🐐", "🦁", "🐍", "🌵"];

/** Edit handle, name, bio and emoji avatar. Handle rules: 3–20, a-z 0-9 _ . */
export default function EditProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, getToken, refresh } = useMe();
  const [handle, setHandle] = useState(me?.handle ?? "");
  const [name, setName] = useState(me?.displayName ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [avatar, setAvatar] = useState(me?.avatar ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cleanHandle = handle.trim().toLowerCase();
  const handleOk = /^[a-z0-9_]{3,20}$/.test(cleanHandle);

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Vuelve a iniciar sesión.");
      const r = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ handle: cleanHandle, displayName: name, bio, avatar }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? "No se pudo guardar");
      await refresh();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Editar perfil">
      <div className="flex items-center gap-3">
        <Avatar seed={avatar || cleanHandle || "p"} size={56} />
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto py-1">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => setAvatar(e)}
              className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xl", avatar === e ? "border-accent bg-[rgba(255,61,23,.12)]" : "border-hairline bg-surface")}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <label className="mt-4 block text-xs text-muted">Usuario</label>
      <div className="mt-1 flex items-center rounded-xl border border-hairline bg-surface px-3 focus-within:border-accent">
        <span className="text-muted">@</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20))}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full bg-transparent py-3 pl-0.5 text-base outline-none"
        />
      </div>
      <p className="mt-1 text-[11px] text-muted-2">3 a 20 caracteres: letras, números y guion bajo. Tu link será patoli.bet/u/{cleanHandle || "…"}</p>

      <label className="mt-3 block text-xs text-muted">Nombre</label>
      <input value={name} onChange={(e) => setName(e.target.value.slice(0, 30))} className="mt-1 w-full rounded-xl border border-hairline bg-surface px-3 py-3 text-base outline-none focus:border-accent" />

      <label className="mt-3 block text-xs text-muted">Bio</label>
      <textarea value={bio} onChange={(e) => setBio(e.target.value.slice(0, 140))} rows={2} className="mt-1 w-full resize-none rounded-xl border border-hairline bg-surface px-3 py-3 text-sm outline-none focus:border-accent" />
      <div className="tnum text-right text-[11px] text-muted-2">{bio.length}/140</div>

      {err ? <p className="mt-2 text-center text-xs text-loss">{err}</p> : null}
      <button onClick={save} disabled={busy || !handleOk || name.trim().length < 1} className="btn-accent mt-3 w-full py-3.5 text-sm">
        {busy ? "Guardando…" : "Guardar"}
      </button>
    </Sheet>
  );
}
