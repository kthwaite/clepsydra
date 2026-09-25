import type { ReactNode } from "react";
import {
  composeRenderProps,
  Radio as RACRadio,
  RadioGroup as RACRadioGroup,
  type RadioGroupProps as RACRadioGroupProps,
  type RadioProps as RACRadioProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export interface RadioGroupProps extends RACRadioGroupProps {
  label?: string;
  optionsClassName?: string;
  /** Draw the options as a segmented control: a sink pill track with the
   *  selected option raised. Off by default so callers with their own chip
   *  rows (Tasking fields) keep full-width layouts. */
  segmented?: boolean;
  description?: string;
  children?: ReactNode;
}

export function RadioGroup({
  label,
  description,
  className,
  optionsClassName,
  segmented = false,
  children,
  ...props
}: RadioGroupProps) {
  return (
    <RACRadioGroup
      {...props}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {label && <span className="text-[12.5px] text-mute">{label}</span>}
      <div
        data-slot={segmented ? "segment-track" : undefined}
        className={cn(
          segmented ? "flex w-fit gap-0.5 rounded-full bg-sink p-1" : "flex",
          optionsClassName,
        )}
      >
        {children}
      </div>
      {description && (
        <span className="text-[12.5px] text-mute">{description}</span>
      )}
    </RACRadioGroup>
  );
}

export function Radio({ className, ...props }: RACRadioProps) {
  return (
    <RACRadio
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "flex cursor-default items-center gap-1.5 rounded-full px-3 py-1 text-[13px] text-mute transition-colors",
          "data-[hovered]:text-ink",
          "data-[selected]:bg-raise data-[selected]:font-medium data-[selected]:text-ink data-[selected]:shadow-sm",
          FOCUS_RING,
          prev,
        ),
      )}
    />
  );
}
