import { Check, CircleAlert } from "lucide-react";
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "#/components/ThemeProvider";

/**
 * App-wide toast surface. Wraps sonner with the Vessel treatment: hard-edged,
 * mono, bottom-right with a bottom-right offset shadow. Toasts are fully
 * unstyled (`unstyled: true`) so the look is ours rather than sonner's rounded
 * default; the type is signalled by a coloured left rule (accent / destructive).
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
        error: <CircleAlert size={14} className="text-destructive" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "cl-mono flex w-full items-center gap-2 border-[1.5px] border-ink bg-paper px-3 py-2 text-[12px] text-ink shadow-[4px_4px_0_0_var(--color-ink)]",
          content: "flex flex-col gap-0.5",
          title: "font-medium tracking-[0.02em]",
          icon: "flex shrink-0 items-center",
          success: "border-l-[3px] border-l-accent",
          error: "border-l-[3px] border-l-destructive",
        },
      }}
    />
  );
}
