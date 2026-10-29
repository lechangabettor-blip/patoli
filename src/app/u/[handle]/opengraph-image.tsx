import { ImageResponse } from "next/og";
import { loadProfile } from "@/lib/social";
import { isSupabaseConfigured } from "@/lib/supabase/server";

/**
 * Link preview for a public profile (WhatsApp, Telegram, X): the record people brag about,
 * rendered on the fly from the same read model as the page. Next wires it as og:image.
 */
export const alt = "Récord en Patoli";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const sign = (n: number, digits = 1, suffix = "") => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}${suffix}`;
const tone = (n: number) => (n > 0 ? "#4ade80" : n < 0 ? "#e24b4a" : "#ffffff");

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle: raw } = await params;
  const handle = raw.toLowerCase();
  const p = isSupabaseConfigured() ? await loadProfile({ handle }).catch(() => null) : null;
  const w = p?.record.w ?? 0;
  const l = p?.record.l ?? 0;
  const units = p?.units ?? 0;
  const pnl = p?.pnl ?? 0;
  const roi = p?.roi ?? 0;
  const avatar = p && /\p{Extended_Pictographic}/u.test(p.avatar) ? p.avatar : (p?.handle[0] ?? handle[0] ?? "p").toUpperCase();
  const tiles: [string, string, string][] = [
    ["Récord", `${w}-${l}`, "#ffffff"],
    ["Unidades", sign(units, 1, "u"), tone(units)],
    ["P&L", `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}$${Math.abs(pnl).toFixed(0)}`, tone(pnl)],
    ["ROI", sign(roi, 1, "%"), tone(roi)],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 64,
          background: "linear-gradient(135deg, #2f2f3e 0%, #1f1f29 55%, #1a1a24 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div
            style={{
              width: 120,
              height: 120,
              borderRadius: 999,
              background: "#343443",
              border: "5px solid #ff3d17",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 60,
              fontWeight: 800,
            }}
          >
            {avatar}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {/* one text child per box: Satori rejects mixed text + expression children without display:flex */}
            <div style={{ fontSize: 60, fontWeight: 800, letterSpacing: -1 }}>{`@${p?.handle ?? handle}`}</div>
            <div style={{ fontSize: 28, color: "#b9b9c7" }}>{p?.displayName && p.displayName !== p.handle ? p.displayName : "Récord verificable en Polygon"}</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 20 }}>
          {tiles.map(([k, v, color]) => (
            <div
              key={k}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "30px 0",
                borderRadius: 28,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div style={{ fontSize: 54, fontWeight: 800, color }}>{v}</div>
              <div style={{ fontSize: 22, color: "#b9b9c7", textTransform: "uppercase", letterSpacing: 4, marginTop: 6 }}>{k}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, color: "#b9b9c7" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ color: "#ff3d17", fontWeight: 800, fontSize: 40, letterSpacing: -1 }}>PATOLI</span>
            <span>Cualquiera opina. Nosotros apostamos.</span>
          </div>
          <div>{`patoli.bet/u/${p?.handle ?? handle}`}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
