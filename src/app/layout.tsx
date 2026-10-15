import type { Metadata, Viewport } from "next";
import { Archivo, Outfit } from "next/font/google";
import "./globals.css";
import Providers from "@/providers/Providers";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-archivo",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Patoli",
    template: "%s · Patoli",
  },
  description:
    "Apuestas sociales. Sigue a la banda, ve sus picks y sus récords, apuesta al mejor precio y reta a quien quieras.",
  applicationName: "Patoli",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Patoli" },
};

export const viewport: Viewport = {
  themeColor: "#1f1f29",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX" className={`${archivo.variable} ${outfit.variable} h-full antialiased`}>
      <body className="min-h-full">
        <div id="app">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
