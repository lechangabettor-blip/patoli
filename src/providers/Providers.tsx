"use client";

import { ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletProvider } from "./WalletProvider";
import { TradingProvider } from "./TradingProvider";
import { MeProvider } from "./MeProvider";

export default function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <TradingProvider>
          <MeProvider>{children}</MeProvider>
        </TradingProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
