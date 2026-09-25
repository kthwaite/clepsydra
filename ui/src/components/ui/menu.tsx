import { Check, ChevronRight } from "lucide-react";
import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable } from "react-aria-components";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  MenuSection as AriaMenuSection,
  type MenuSectionProps as AriaMenuSectionProps,
  MenuTrigger as AriaMenuTrigger,
  type MenuTriggerProps as AriaMenuTriggerProps,
  Separator as AriaSeparator,
  SubmenuTrigger as AriaSubmenuTrigger,
  type SubmenuTriggerProps as AriaSubmenuTriggerProps,
  Keyboard,
  type SeparatorProps,
  Text,
} from "react-aria-components/Menu";
import { Popover } from "#/components/ui/popover";
import { cn } from "#/lib/cn";

const menuClass =
  "min-w-[200px] max-w-[min(320px,calc(100vw-16px))] overflow-auto rounded-xl bg-raise p-1.5 text-[13.5px] text-ink shadow-lg outline-none";

const itemClass =
  "group flex cursor-default items-center gap-2.5 rounded-lg px-3 py-1.5 outline-none data-[focused]:bg-sink data-[selected]:bg-accent-tint data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45";

function splitTriggerChildren(
  componentName: string,
  children: ReactNode,
): [ReactElement, ReactElement] {
  const childArray = Children.toArray(children);

  if (
    childArray.length !== 2 ||
    !isValidElement(childArray[0]) ||
    !isValidElement(childArray[1])
  ) {
    throw new Error(
      `${componentName} requires exactly two element children: a trigger and a menu.`,
    );
  }

  return [childArray[0], childArray[1]];
}

export function MenuTrigger(props: AriaMenuTriggerProps) {
  const [trigger, menu] = splitTriggerChildren("MenuTrigger", props.children);

  return (
    <AriaMenuTrigger {...props}>
      {trigger}
      <Popover hideArrow>{menu}</Popover>
    </AriaMenuTrigger>
  );
}

export function ContextMenuTrigger({
  children,
  ...props
}: Omit<AriaMenuTriggerProps, "trigger">) {
  const [trigger, menu] = splitTriggerChildren("ContextMenuTrigger", children);
  const contextTarget = trigger as ComponentProps<typeof Pressable>["children"];

  return (
    <AriaMenuTrigger {...props} trigger="contextMenu">
      <Pressable>{contextTarget}</Pressable>
      <Popover hideArrow>{menu}</Popover>
    </AriaMenuTrigger>
  );
}

export function Menu<T extends object>({
  className,
  children,
  ...props
}: AriaMenuProps<T>) {
  return (
    <AriaMenu
      {...props}
      className={composeRenderProps(className, (className) =>
        cn(menuClass, className),
      )}
    >
      {children}
    </AriaMenu>
  );
}

export type MenuItemVariant = "default" | "destructive";

export interface MenuItemProps extends AriaMenuItemProps {
  variant?: MenuItemVariant;
  icon?: ReactNode;
  swatch?: string;
  description?: string;
  shortcut?: string;
}

export function MenuItem({
  variant = "default",
  icon,
  swatch,
  description,
  shortcut,
  className,
  children,
  textValue: providedTextValue,
  ...props
}: MenuItemProps) {
  const textValue =
    providedTextValue ?? (typeof children === "string" ? children : undefined);

  return (
    <AriaMenuItem
      {...props}
      textValue={textValue}
      data-variant={variant}
      className={composeRenderProps(className, (className) =>
        cn(itemClass, "data-[variant=destructive]:text-hot", className),
      )}
    >
      {composeRenderProps(
        children,
        (children, { hasSubmenu, isSelected, selectionMode }) => (
          <>
            {selectionMode !== "none" && (
              <span
                aria-hidden="true"
                className="flex size-3.5 shrink-0 items-center justify-center"
                data-slot="selection-indicator"
              >
                {isSelected && <Check className="size-3.5" strokeWidth={2.5} />}
              </span>
            )}
            {icon ? (
              <span
                aria-hidden="true"
                className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
                data-slot="icon"
              >
                {icon}
              </span>
            ) : swatch ? (
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                data-slot="swatch"
                style={{ backgroundColor: swatch }}
              />
            ) : null}
            <span className="flex min-w-0 flex-1 flex-col">
              <Text className="truncate" slot="label">
                {children}
              </Text>
              {description && (
                <Text className="text-[12px] text-mute" slot="description">
                  {description}
                </Text>
              )}
            </span>
            {shortcut && (
              <Keyboard className="ml-auto shrink-0 font-sans text-[12px] text-faint">
                {shortcut}
              </Keyboard>
            )}
            {hasSubmenu && (
              <ChevronRight
                aria-hidden="true"
                className="ml-auto size-3.5 shrink-0"
              />
            )}
          </>
        ),
      )}
    </AriaMenuItem>
  );
}

export function MenuSection<T extends object>(props: AriaMenuSectionProps<T>) {
  return <AriaMenuSection {...props} />;
}

export function MenuSeparator({ className, ...props }: SeparatorProps) {
  return <AriaSeparator {...props} className={cn("my-1 h-1.5", className)} />;
}

export function SubmenuTrigger(props: AriaSubmenuTriggerProps) {
  const [trigger, menu] = splitTriggerChildren(
    "SubmenuTrigger",
    props.children,
  );

  return (
    <AriaSubmenuTrigger {...props}>
      {trigger}
      <Popover hideArrow offset={-2} crossOffset={-4}>
        {menu}
      </Popover>
    </AriaSubmenuTrigger>
  );
}
