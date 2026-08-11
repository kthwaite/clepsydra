import type { ReactNode } from "react";
import { Radio, RadioGroup } from "#/components/ui/radio-group";

export interface SegmentedControlOption {
  id: string;
  label: string;
  visual?: ReactNode;
}

export interface SegmentedControlProps {
  label: string;
  value: string;
  options: readonly SegmentedControlOption[];
  onChange: (value: string) => void;
  className?: string;
  optionsClassName?: string;
  itemClassName?: string;
}

export function SegmentedControl({
  label,
  value,
  options,
  onChange,
  className,
  optionsClassName,
  itemClassName,
}: SegmentedControlProps) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onChange={onChange}
      className={className}
      optionsClassName={optionsClassName}
    >
      {options.map((option) => (
        <Radio key={option.id} value={option.id} className={itemClassName}>
          {option.visual != null && (
            <span aria-hidden="true" className="contents">
              {option.visual}
            </span>
          )}
          <span>{option.label}</span>
        </Radio>
      ))}
    </RadioGroup>
  );
}
