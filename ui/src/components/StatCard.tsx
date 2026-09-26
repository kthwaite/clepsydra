interface StatCardProps {
  label: string;
  value: number;
}

/** A stat cell (Stats inventory idiom): sentence-case label in mute over a
 *  large tabular serif value, on raise. No border. */
export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl bg-raise px-[18px] py-3.5">
      <p className="truncate text-[13px] text-mute">{label}</p>
      <p className="font-serif text-[46px] leading-none tabular-nums text-ink">
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}
