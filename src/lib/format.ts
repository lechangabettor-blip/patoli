const MX_TZ = "America/Mexico_City";

export function shortAddress(a?: string | null, n = 4) {
  if (!a) return "";
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

/** Kickoff label relative to `now`; empty while the clock is unknown (prerender). */
/** Game has started and is plausibly still running (the board already drops games that are surely over). */
export function isLive(iso: string, now: Date): boolean {
  const diff = now.getTime() - new Date(iso).getTime();
  return diff >= 0 && diff < 4 * 3600_000;
}

export function kickoffLabel(iso: string, now: Date | null): string {
  if (!now) return "";
  const d = new Date(iso);
  const diffMs = d.getTime() - now.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins <= 0 && mins > -200) return "En juego";
  if (mins < 0) return "Terminó";
  if (mins < 60) return `En ${mins} min`;
  const day = (x: Date) => x.toLocaleDateString("es-MX", { timeZone: MX_TZ });
  const time = d.toLocaleTimeString("es-MX", { timeZone: MX_TZ, hour: "numeric", minute: "2-digit" });
  if (day(d) === day(now)) return `Hoy ${time}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (day(d) === day(tomorrow)) return `Mañana ${time}`;
  return `${d.toLocaleDateString("es-MX", { timeZone: MX_TZ, weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function timeAgo(iso: string, now: Date | null): string {
  if (!now) return "";
  const s = Math.max(1, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function signed(n: number, digits = 2): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}
