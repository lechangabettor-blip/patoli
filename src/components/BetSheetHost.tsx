"use client";

import { useEffect } from "react";
import BetSheet from "./BetSheet";
import { closeBet, useBetSelection } from "@/lib/bet-store";

let pendingClose: ReturnType<typeof setTimeout> | null = null;

/**
 * The single bet sheet instance (see lib/bet-store.ts). Mounted once in the tabs layout and on
 * public profiles. The selection lives in a module store, so it must not outlive its page: it is
 * closed on browser back/forward and whenever this host unmounts. The unmount close is deferred a
 * tick so React's dev-only mount → unmount → mount pass (StrictMode) cannot wipe a selection the
 * game page's reopen effect wrote during the same mount.
 */
export default function BetSheetHost() {
  const sel = useBetSelection();
  useEffect(() => {
    if (pendingClose) {
      clearTimeout(pendingClose);
      pendingClose = null;
    }
    window.addEventListener("popstate", closeBet);
    return () => {
      window.removeEventListener("popstate", closeBet);
      pendingClose = setTimeout(() => {
        pendingClose = null;
        closeBet();
      }, 0);
    };
  }, []);
  return <BetSheet selection={sel} onClose={closeBet} />;
}
