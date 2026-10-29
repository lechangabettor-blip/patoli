import BottomNav from "@/components/BottomNav";
import AutoSettle from "@/components/AutoSettle";
import BetSheetHost from "@/components/BetSheetHost";

export default function TabsLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <main className="mx-auto min-h-dvh max-w-md" style={{ paddingBottom: "calc(var(--nav-h) + var(--safe-b) + 16px)" }}>
        {children}
      </main>
      <BottomNav />
      <AutoSettle />
      <BetSheetHost />
    </>
  );
}
