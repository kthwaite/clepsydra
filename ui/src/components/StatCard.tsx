interface StatCardProps {
  label: string;
  value: number;
}

export function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="border border-border p-4">
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
    </div>
  );
}
