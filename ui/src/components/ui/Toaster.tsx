import { Check, CircleAlert } from "lucide-react";
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "#/components/ThemeProvider";

/**
 * App-wide toast surface. Wraps sonner with the Stone & Lamp treatment: a
 * raised, rounded card with a soft shadow, bottom-right. Toasts are fully
 * unstyled (`unstyled: true`) so the look is ours; the type is signalled by
 * the leading icon's colour (accent / hot).
 *
 * Mounted once at the root, inside ThemeProvider, so it can mirror the resolved
 * light/dark theme.
 */
export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolvedTheme}
      position="bottom-right"
      gap={8}
      offset={16}
      icons={{
        success: <Check size={14} className="text-accent" />,
        error: <CircleAlert size={14} className="text-hot" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-full items-center gap-3 rounded-xl bg-raise px-4 py-3 text-[13.5px] text-ink shadow-lg",
          content: "flex flex-col gap-0.5",
          title: "font-medium",
          description: "text-[12.5px] text-mute",
          icon: "flex shrink-0 items-center",
        },
      }}
    />
  );
}
