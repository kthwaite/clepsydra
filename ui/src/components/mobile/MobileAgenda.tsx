import { useId, useState } from "react";
import type { AgendaResponse } from "#/api/tasks";
import { AgendaRow, Eyebrow } from "#/components/mobile/MobileParts";
import {
  type AgendaBucketKey,
  agendaItemKey,
  bucketAgenda,
} from "#/components/mobile/mobile-data";
import { pageName, usePeople } from "#/hooks/usePeople";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { todoAssigneePerson } from "#/lib/todoAssignee";

const TICK: Record<AgendaBucketKey, string> = {
  overdue: "bg-hot",
  today: "bg-accent",
  week: "bg-faint",
  undated: "bg-faint",
};

interface AgendaQuery {
  data: AgendaResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/** Mobile Agenda (spec §9 Q3): open items overdue, due today, due in the
 *  next seven days, or undated — the server's Agenda window. */
export function MobileAgenda({
  agenda,
  today,
  personId,
  onPersonChange,
}: {
  agenda: AgendaQuery;
  today: string;
  personId?: string;
  onPersonChange?: (id: string) => void;
}) {
  const people = usePeople();
  const filterId = useId();
  const [localPersonId, setLocalPersonId] = useState("");
  const selectedPerson = personId ?? localPersonId;
  const buckets = (agenda.data ? bucketAgenda(agenda.data) : [])
    .map((bucket) => ({
      ...bucket,
      items: selectedPerson
        ? bucket.items.filter(
            (item) =>
              item.kind === "todo" &&
              todoAssigneePerson(item.properties.assignee, people)?.id ===
                selectedPerson,
          )
        : bucket.items,
    }))
    .filter((bucket) => bucket.items.length > 0);
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
      <div className="flex flex-col gap-2">
        <label htmlFor={filterId} className="text-[13px] text-mute">
          Inline TODO person
        </label>
        <select
          id={filterId}
          value={selectedPerson}
          onChange={(event) => {
            setLocalPersonId(event.target.value);
            onPersonChange?.(event.target.value);
          }}
          className={cn(
            "min-h-11 rounded-xl bg-sink px-3 text-[15px] text-ink",
            FOCUS_RING_NATIVE,
          )}
        >
          <option value="">All people and Task pages</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {pageName(person)}
            </option>
          ))}
        </select>
      </div>

      {agenda.isLoading && <p className="text-[15px] text-mute">Loading…</p>}
      {agenda.isError && (
        <p role="alert" className="text-[15px] text-hot">
          Agenda failed to load.
        </p>
      )}
      {agenda.data && buckets.length === 0 && (
        <p className="text-[15px] text-mute">
          {selectedPerson
            ? "No inline TODOs assigned to this person."
            : "Nothing open."}
        </p>
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
