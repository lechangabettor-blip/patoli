"use client";

import Link from "next/link";
import { Wallet } from "lucide-react";
import Logo from "./Logo";
import { useWallet } from "@/providers/WalletContext";
import { useUsdcBalance } from "@/hooks/useUsdcBalance";
import { formatUsd } from "@/lib/polymarket/odds";

export default function TopBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  const { status } = useWallet();
  const { balance, isLoading } = useUsdcBalance();
  return (
    <header
      className="sticky top-0 z-30 border-b border-hairline bg-[rgba(31,31,41,0.72)] backdrop-blur-xl"
      // Installed on an iPhone home screen the status bar overlays the page: the bar grows by the top safe area.
      style={{ height: "calc(var(--top-h) + var(--safe-t))", paddingTop: "var(--safe-t)" }}
    >
      <div className="mx-auto flex h-full max-w-md items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={30} wordClassName="text-xl leading-none" />
          {title ? <span className="font-display text-xs font-bold uppercase tracking-widest text-muted">{title}</span> : null}
        </Link>
        <div className="flex items-center gap-2">
          {right}
          {status === "connected" ? (
            <Link href="/perfil" className="btn-ghost tnum flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold">
              <Wallet className="h-4 w-4 text-accent-soft" />
              {isLoading ? <span className="skeleton inline-block h-3 w-10" /> : `$${formatUsd(balance)}`}
            </Link>
          ) : (
            <Link href="/entrar" className="btn-accent px-4 py-1.5 text-xs">
              Entrar
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
