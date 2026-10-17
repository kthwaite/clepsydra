import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ToggleButton } from "react-aria-components";
import { TooltipIconButton } from "#/components/ui/icon-button";
import { Lightbox } from "#/components/ui/lightbox";
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
function DiagramSvg({ svg, fit = false }: { svg: string; fit?: boolean }) {
  return (
    <div
      className={cn(
        "cl-mermaid-svg flex justify-center [&>svg]:max-w-full",
        fit ? "h-full [&>svg]:h-full [&>svg]:w-full" : "[&>svg]:h-auto",
      )}
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
          "overflow-x-auto whitespace-pre-wrap rounded-xl bg-sink px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink-2",
          className,
        )}
        data-testid="mermaid-error"
      >
        <span className="font-medium text-hot">Diagram error</span> —{" "}
        {state.message}
      </p>
    );
  }

  return (
    <div className={cn("px-4 py-3", className)} data-testid="mermaid-diagram">
      {state.status === "pending" ? (
        <p className="text-center text-[12.5px] text-mute">
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
  source,
  className,
}: {
  svg: string | null;
  source: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Re-rendering the diagram (on a theme change, say) empties `svg` until
  // mermaid comes back. An open lightbox holds the last picture across that
  // gap, rather than closing itself and snatching focus back to this button.
  const held = useRef<string | null>(null);
  useEffect(() => {
    if (svg !== null) held.current = svg;
  }, [svg]);
  const shown = svg ?? (open ? held.current : null);

  if (shown === null) return null;

  return (
    <>
      <TooltipIconButton
        aria-label="Expand diagram"
        onPress={() => setOpen(true)}
        className={className}
      >
        <Maximize2 size={13} />
      </TooltipIconButton>
      <Lightbox isOpen={open} onOpenChange={setOpen} label="Diagram">
        <div className="h-full w-full">
          <DiagramSvg svg={shown} fit />
        </div>
        {/* The modal hides the page's source from assistive tech while open.
            Keep exactly one source here rather than announcing both SVG text
            and Mermaid syntax. */}
        <pre className="sr-only">
          <code>{source}</code>
        </pre>
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
        "h-7 cursor-pointer rounded-full bg-sink px-2.5 text-[12.5px] outline-none transition-colors",
        "text-mute data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent data-[hovered]:text-ink",
        "data-[selected]:bg-accent-tint data-[selected]:text-accent",
        className,
      )}
    >
      Diagram
    </ToggleButton>
  );
}
