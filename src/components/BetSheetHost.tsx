"use client";

import { useEffect } from "react";
import BetSheet from "./BetSheet";
import { closeBet, useBetSelection } from "@/lib/bet-store";

/**
 * The single bet sheet instance (see lib/bet-store.ts). Mounted once in the tabs layout and on
 * public profiles. The selection lives in a module store, so it must not outlive its page: it is
 * closed on browser back/forward and whenever this host unmounts.
 */
export default function BetSheetHost() {
  const sel = useBetSelection();
  useEffect(() => {
    window.addEventListener("popstate", closeBet);
    return () => {
      window.removeEventListener("popstate", closeBet);
      closeBet();
    };
  }, []);
  return <BetSheet selection={sel} onClose={closeBet} />;
}
