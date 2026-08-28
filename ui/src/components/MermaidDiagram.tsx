import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, ToggleButton, TooltipTrigger } from "react-aria-components";
import { Lightbox } from "#/components/ui/lightbox";
import { VesselTooltip } from "#/components/ui/tooltip";
import { cn } from "#/lib/cn";
import {
  type MermaidRenderResult,
  renderMermaid,
  subscribeToTheme,
  themeSignature,
} from "#/lib/mermaid";

export type MermaidState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

const IDLE: MermaidState = { status: "idle" };

/** Re-renders the caller whenever the Vessel palette changes. */
function useThemeSignature(): string {
  return useSyncExternalStore(subscribeToTheme, themeSignature);
}

/**
 * Renders `code` to an SVG, or reports why it could not. Pass `null` to stand
 * down — while the source is being edited or shown, nothing is rendered and no
 * mermaid chunk is fetched.
 */
export function useMermaidRender(code: string | null): MermaidState {
  const theme = useThemeSignature();
  const [state, setState] = useState<MermaidState>(IDLE);

  useEffect(() => {
    if (code === null) {
      setState(IDLE);
      return;
    }

    let active = true;
    setState({ status: "pending" });
    void renderMermaid(code, theme).then((result: MermaidRenderResult) => {
      if (!active) return;
      setState(
        result.ok
          ? { status: "ready", svg: result.svg }
          : { status: "error", message: result.message },
      );
    });

    return () => {
      active = false;
    };
  }, [code, theme]);

  return state;
}

/**
 * The rendered picture itself. Sized to its container, so it fits the reading
 * column inline and the stage inside a lightbox.
 */
function DiagramSvg({ svg }: { svg: string }) {
  return (
    <div
      className="cl-mermaid-svg flex justify-center [&>svg]:h-auto [&>svg]:max-w-full"
      // The authored source stays available to assistive tech in the block's
      // <pre>; the picture itself is decorative.
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid produces this SVG with securityLevel "strict" at the only rendering boundary.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Presentational half of a mermaid render: the diagram, a placeholder while the
 * renderer loads, or the parse error. Callers keep the source visible when the
 * state is an error.
 */
export function MermaidDiagram({
  state,
  className,
}: {
  state: MermaidState;
  className?: string;
}) {
  if (state.status === "idle") return null;

  if (state.status === "error") {
    return (
      <p
        className={cn(
          "cl-mono overflow-x-auto whitespace-pre-wrap border-l-2 border-destructive bg-paper px-3 py-2 text-[10px] leading-[1.5] text-ink-2",
          className,
        )}
        data-testid="mermaid-error"
      >
        <span className="uppercase tracking-[0.18em] text-destructive">
          Diagram error
        </span>{" "}
        — {state.message}
      </p>
    );
  }

  return (
    <div className={cn("px-4 py-3", className)} data-testid="mermaid-diagram">
      {state.status === "pending" ? (
        <p className="cl-mono text-center text-[9px] uppercase tracking-[0.18em] text-ink-mute">
          Rendering diagram…
        </p>
      ) : (
        <DiagramSvg svg={state.svg} />
      )}
    </div>
  );
}

/**
 * Header control that opens the rendered diagram in a pan/zoom lightbox, for
 * diagrams too dense to read at the width of the reading column. Renders
 * nothing until there is an SVG to show.
 */
export function MermaidExpandButton({
  svg,
  className,
}: {
  svg: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Re-rendering the diagram (on a theme change, say) empties `svg` until
  // mermaid comes back. An open lightbox holds the last picture across that
  // gap, rather than closing itself and snatching focus back to this button.
  const held = useRef<string | null>(null);
  if (svg !== null) held.current = svg;
  const shown = svg ?? (open ? held.current : null);

  if (shown === null) return null;

  return (
    <>
      <TooltipTrigger delay={300} closeDelay={0}>
        <Button
          aria-label="Expand diagram"
          onPress={() => setOpen(true)}
          className={cn(
            "inline-flex cursor-pointer items-center justify-center bg-transparent p-0 text-ink-mute outline-none transition-colors data-[focus-visible]:text-accent data-[hovered]:text-accent",
            // Stay reachable when a parent uses `className` to hover-reveal us.
            "data-[focus-visible]:opacity-100",
            className,
          )}
        >
          <Maximize2 size={13} />
        </Button>
        <VesselTooltip>Expand diagram</VesselTooltip>
      </TooltipTrigger>
      <Lightbox isOpen={open} onOpenChange={setOpen} label="Diagram">
        <div className="w-full">
          <DiagramSvg svg={shown} />
        </div>
      </Lightbox>
    </>
  );
}

/**
 * Header control that flips a mermaid block between its diagram and its source.
 * React Aria's button suppresses the mousedown default, so it leaves the Slate
 * selection alone when it sits in the editor's code-block header.
 */
export function MermaidViewToggle({
  isDiagram,
  onChange,
  className,
}: {
  isDiagram: boolean;
  onChange: (isDiagram: boolean) => void;
  className?: string;
}) {
  return (
    <ToggleButton
      isSelected={isDiagram}
      onChange={onChange}
      aria-label="Show diagram"
      className={cn(
        "cl-mono cursor-pointer bg-transparent uppercase tracking-[0.18em] outline-none transition-colors",
        "text-ink-mute data-[focus-visible]:text-accent data-[hovered]:text-accent",
        "data-[selected]:text-accent data-[selected]:data-[hovered]:text-accent-deep",
        className,
      )}
    >
      Diagram
    </ToggleButton>
  );
}
