import type { ReactNode } from "react";
import type { AgendaItem } from "#/api/tasks";
import { useToggleTaskStatus } from "#/api/tasks";
import { Tick } from "#/components/codex/Tick";
import {
  agendaItemPath,
  agendaItemTitle,
} from "#/components/mobile/mobile-data";
import {
  PRI_LABEL,
  taskStatusLabel,
} from "#/components/tasking/board-constants";
import { Checkbox } from "#/components/ui/checkbox";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** A mobile section heading: tick, italic serif label, optional action. */
export function Eyebrow({
  label,
  tick = "bg-accent",
  tone = "text-ink",
  count,
  action,
}: {
  label: string;
  /** Tick fill class. */
  tick?: string;
  /** Label colour class. */
  tone?: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Tick className={tick} />
      <h2 className={cn("font-serif text-[20px] italic leading-none", tone)}>
        {label}
      </h2>
      {count !== undefined && (
        <span className="text-[12.5px] text-mute">{count}</span>
      )}
      <span className="flex-1" />
      {action}
    </div>
  );
}

/** "Open →"-style link beside an eyebrow. */
export function EyebrowAction({
  label,
  children,
  onPress,
}: {
  label: string;
  children: ReactNode;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className={cn(
        "min-h-11 rounded-md px-1 text-[14px] text-accent",
        FOCUS_RING_NATIVE,
      )}
    >
      {children}
    </button>
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-22" → "22 Sep" (fixed names: ICU writes "Sept" for en-GB). */
function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

function dueOf(item: AgendaItem): string | undefined {
  return item.kind === "task" ? item.due : item.properties.due;
}

/** The line under an agenda row: overdue date, or the item's source. */
function agendaMeta(
  item: AgendaItem,
  today: string,
  withDate = false,
): { text: string; overdue: boolean } {
  const due = dueOf(item);
  if (due && due < today)
    return { text: `Overdue · ${shortDate(due)}`, overdue: true };
  const source =
    item.kind === "task"
      ? [
          item.code,
          taskStatusLabel(item.status),
          PRI_LABEL[item.priority] ?? item.priority,
        ].join(" · ")
      : (item.page_title ?? item.page_path);
  const date = withDate && due && due !== today ? `${shortDate(due)} · ` : "";
  return { text: `${date}${source}`, overdue: false };
}

/** One agenda row: todos check off in place; tasks open their page (their
 *  status is set on the task, not with a checkbox). */
export function AgendaRow({
  item,
  today,
  withDate = false,
}: {
  item: AgendaItem;
  today: string;
  withDate?: boolean;
}) {
  const toggle = useToggleTaskStatus();
  const openTab = useOpenTab();
  const meta = agendaMeta(item, today, withDate);
  const metaLine = (
    <span
      className={cn(
        "truncate text-[12.5px]",
        meta.overdue ? "text-hot" : "text-mute",
      )}
    >
      {meta.text}
    </span>
  );

  if (item.kind === "task") {
    return (
      <button
        type="button"
        onClick={() => openTab("page", item.path, item.title)}
        className={cn(
          "ml-[17px] flex min-h-11 min-w-0 flex-col gap-[3px] rounded-md text-left",
          FOCUS_RING_NATIVE,
        )}
      >
        <span className="text-[15.5px] leading-[1.35] text-ink">
          {item.title}
        </span>
        {metaLine}
      </button>
    );
  }

  return (
    <div className="ml-[17px] flex min-w-0 flex-col gap-[3px]">
      <Checkbox
        isDisabled={toggle.isPending}
        onChange={(checked) => {
          if (!checked) return;
          toggle.mutate({
            pagePath: agendaItemPath(item),
            spanStart: item.span_start,
            status: "done",
          });
        }}
        className="min-h-11 justify-center [&_[data-slot=checkbox-box]]:size-[18px]"
      >
        <span className="text-[15.5px] leading-[1.35]">
          {agendaItemTitle(item)}
        </span>
      </Checkbox>
      <span className="-mt-2.5 flex pl-[26px]">{metaLine}</span>
    </div>
  );
}
