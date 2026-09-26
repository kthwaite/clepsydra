import type { AgendaResponse } from "#/api/tasks";
import { AgendaRow, Eyebrow } from "#/components/mobile/MobileParts";
import {
  type AgendaBucketKey,
  agendaItemKey,
  bucketAgenda,
} from "#/components/mobile/mobile-data";

const TICK: Record<AgendaBucketKey, string> = {
  overdue: "bg-hot",
  today: "bg-accent",
  week: "bg-faint",
  later: "bg-faint",
  undated: "bg-faint",
};

interface AgendaQuery {
  data: AgendaResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** Mobile Agenda (spec §9 Q3): every open item by when it is due. */
export function MobileAgenda({
  agenda,
  today,
}: {
  agenda: AgendaQuery;
  today: string;
}) {
  const buckets = agenda.data ? bucketAgenda(agenda.data, today) : [];
  const open = buckets.reduce((n, b) => n + b.items.length, 0);

  return (
    <div className="flex flex-col gap-[26px] px-5 pt-1 pb-10">
      <div className="flex items-baseline gap-3">
        <h1 className="flex-1 font-serif text-[44px] leading-none text-ink">
          Agenda
        </h1>
        {agenda.data && (
          <span className="text-[13px] text-mute">{`${open} open`}</span>
        )}
      </div>

      {agenda.isLoading && <p className="text-[15px] text-mute">Loading…</p>}
      {agenda.isError && (
        <p role="alert" className="text-[15px] text-hot">
          Agenda failed to load.
        </p>
      )}
      {agenda.data && buckets.length === 0 && (
        <p className="text-[15px] text-mute">Nothing open.</p>
      )}

      {buckets.map((bucket) => (
        <section key={bucket.key} className="flex flex-col gap-3.5">
          <Eyebrow
            label={bucket.label}
            tick={TICK[bucket.key]}
            tone={bucket.key === "overdue" ? "text-hot" : "text-ink"}
            count={bucket.items.length}
          />
          {bucket.items.map((item) => (
            <AgendaRow
              key={agendaItemKey(item)}
              item={item}
              today={today}
              withDate={bucket.key !== "today"}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
