import Image from "next/image";
import { cn } from "@/lib/cn";

/** The Patoli mark (LeChanga's ape, orange) with optional wordmark. */
export default function Logo({ size = 28, word = true, className, wordClassName }: { size?: number; word?: boolean; className?: string; wordClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Image src="/brand/mark.png" alt="" width={size} height={size} priority className="shrink-0 object-contain" style={{ width: size, height: size }} />
      {word ? <span className={cn("font-display font-extrabold uppercase tracking-tight text-accent", wordClassName)}>Patoli</span> : null}
    </span>
  );
}
