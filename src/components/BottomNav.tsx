"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Trophy, Search, User, Swords } from "lucide-react";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/", label: "Inicio", Icon: Home },
  { href: "/deportes", label: "Deportes", Icon: Trophy },
  { href: "/batalla", label: "Batalla", Icon: Swords, center: true },
  { href: "/buscar", label: "Buscar", Icon: Search },
  { href: "/perfil", label: "Perfil", Icon: User },
] as const;

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Navegación principal"
      className="fixed inset-x-0 bottom-0 z-40"
      style={{ paddingBottom: "var(--safe-b)" }}
    >
      <div className="mx-auto max-w-md">
        <div
          className="relative grid grid-cols-5 items-end border-t border-hairline bg-[rgba(31,31,41,0.86)] backdrop-blur-xl"
          style={{ height: "var(--nav-h)" }}
        >
          {TABS.map(({ href, label, Icon, ...rest }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            const center = "center" in rest && rest.center;
            if (center) {
              return (
                <Link
                  key={href}
                  href={href}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  className="relative flex flex-col items-center justify-end pb-1.5"
                >
                  <span
                    className={cn(
                      "-mt-7 flex h-14 w-14 items-center justify-center rounded-full border-4 border-bg transition-transform",
                      active ? "bg-accent scale-105 shadow-[0_10px_30px_rgba(255,61,23,.45)]" : "bg-accent shadow-[0_8px_24px_rgba(255,61,23,.35)]",
                    )}
                  >
                    <Icon className="h-6 w-6 text-white" strokeWidth={2.4} />
                  </span>
                  <span className={cn("mt-1 font-display text-[10px] font-bold uppercase tracking-wide", active ? "text-accent-soft" : "text-muted")}>
                    {label}
                  </span>
                </Link>
              );
            }
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className="flex h-full flex-col items-center justify-center gap-1 pt-1"
              >
                <Icon className={cn("h-[22px] w-[22px] transition-colors", active ? "text-accent" : "text-muted")} strokeWidth={active ? 2.4 : 1.9} />
                <span className={cn("font-display text-[10px] font-bold uppercase tracking-wide", active ? "text-ink" : "text-muted")}>{label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
