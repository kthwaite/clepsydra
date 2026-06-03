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
      className={cn("group flex items-center gap-2", className)}
    >
      <Search className="h-4 w-4 text-muted-foreground" />
      <Input
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <Button className="p-1 text-muted-foreground data-[hovered]:text-foreground group-data-[empty]:hidden">
        <X className="h-3 w-3" />
      </Button>
    </RACSearchField>
  );
}
