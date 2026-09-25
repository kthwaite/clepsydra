import { Search, X } from "lucide-react";
import {
  Button,
  Input,
  SearchField as RACSearchField,
  type SearchFieldProps as RACSearchFieldProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface SearchFieldProps extends RACSearchFieldProps {
  placeholder?: string;
}

export function SearchField({
  placeholder,
  className,
  ...props
}: SearchFieldProps) {
  return (
    <RACSearchField
      {...props}
      className={cn(
        "group flex h-10 items-center gap-2 rounded-full bg-sink px-4 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent",
        className,
      )}
    >
      <Search className="h-4 w-4 text-mute" />
      <Input
        placeholder={placeholder}
        className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-mute"
      />
      <Button className="rounded-full p-1 text-mute data-[hovered]:text-ink group-data-[empty]:hidden">
        <X className="h-3 w-3" />
      </Button>
    </RACSearchField>
  );
}
