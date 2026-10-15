import { cn } from "@/lib/cn";

export default function Avatar({ seed, size = 40, className }: { seed: string; size?: number; className?: string }) {
  const isEmoji = /\p{Extended_Pictographic}/u.test(seed);
  const hue = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-display font-extrabold uppercase text-white", className)}
      style={{
        width: size,
        height: size,
        fontSize: size * (isEmoji ? 0.5 : 0.42),
        background: isEmoji
          ? "var(--surface-2)"
          : `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 80% 38%))`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.08)",
      }}
    >
      {isEmoji ? seed : seed.slice(0, 1)}
    </span>
  );
}
