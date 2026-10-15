import type { Metadata } from "next";
import { Suspense } from "react";
import LoginScreen from "@/components/LoginScreen";

export const metadata: Metadata = { title: "Entrar" };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginScreen />
    </Suspense>
  );
}
