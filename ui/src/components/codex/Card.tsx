import { clsx } from "clsx";
import type { ReactNode } from "react";

type Pip = "cool" | "hot" | "dim";

const PIP_CLASS: Record<Pip, string> = {
  cool: "bg-cool animate-pulse",
  hot: "bg-accent animate-pulse",
  dim: "bg-ink-mute",
};

export function Card({
  label,
  caption,
  pip = "cool",
  tight = false,
  className,
  children,
}: {
  label: string;
  caption?: ReactNode;
  pip?: Pip;
  tight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx("border border-rule bg-paper-2", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={clsx("h-[7px] w-[7px] flex-shrink-0", PIP_CLASS[pip])}
          />
          <span className="cl-mono truncate text-[9px] font-medium uppercase tracking-[0.22em] text-ink">
            {label}
          </span>
        </div>
        {caption ? (
          <span className="cl-mono whitespace-nowrap text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            {caption}
          </span>
        ) : null}
      </div>
      <div className={tight ? "" : "p-3.5"}>{children}</div>
    </section>
  );
}
