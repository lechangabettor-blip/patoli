import type { Metadata } from "next";
import { Suspense } from "react";
import SportsBoard from "@/components/SportsBoard";

export const metadata: Metadata = { title: "Deportes" };

export default function SportsPage() {
  return (
    <Suspense fallback={null}>
      <SportsBoard />
    </Suspense>
  );
}
