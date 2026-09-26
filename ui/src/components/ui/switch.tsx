import {
  composeRenderProps,
  Switch as RACSwitch,
  type SwitchProps as RACSwitchProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export type SwitchProps = RACSwitchProps;

/** A labelled on/off switch (spec §9 Q2: the tables' Compact switch): a
 *  sink pill holding a 30×18 track, cobalt when on. */
export function Switch({ className, children, ...props }: SwitchProps) {
  return (
    <RACSwitch
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "group flex h-9 cursor-default items-center gap-2.5 rounded-full bg-sink pr-3.5 pl-2.5 text-[13px] text-ink",
          FOCUS_RING,
          prev,
        ),
      )}
    >
      {composeRenderProps(children, (kids) => (
        <>
          <span
            aria-hidden
            className="relative block h-[18px] w-[30px] rounded-full bg-faint transition-colors group-data-[selected]:bg-accent"
          >
            <span className="absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-raise shadow-sm transition-transform group-data-[selected]:translate-x-3" />
          </span>
          {kids}
        </>
      ))}
    </RACSwitch>
  );
}
