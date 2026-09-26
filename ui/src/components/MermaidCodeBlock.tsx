import { useState } from "react";
import {
  MermaidDiagram,
  MermaidExpandButton,
  MermaidViewToggle,
  useMermaidRender,
} from "#/components/MermaidDiagram";
import { CopyButton } from "#/components/ui/CopyButton";
import { cn } from "#/lib/cn";

/**
 * A ```mermaid fence in rendered markdown: the diagram by default, with a
 * header toggle back to the raw source. A source that mermaid cannot parse
 * falls back to the code with the error above it, so the content is never lost.
 */
export function MermaidCodeBlock({ code }: { code: string }) {
  const [diagram, setDiagram] = useState(true);
  const state = useMermaidRender(diagram ? code : null);
  const showSource = !diagram || state.status === "error";

  return (
    <div className="group my-4 overflow-hidden rounded-xl bg-sink">
      <div
        className="flex select-none items-center justify-between px-3.5 pt-2 pb-1 text-[12.5px] text-mute"
        data-testid="mermaid-block-header"
      >
        <span>Mermaid</span>
        <div className="flex items-center gap-2.5">
          <CopyButton
            getText={() => code}
            label="Copy code"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          />
          <MermaidExpandButton
            svg={state.status === "ready" ? state.svg : null}
          />
          <MermaidViewToggle isDiagram={diagram} onChange={setDiagram} />
        </div>
      </div>
      <MermaidDiagram state={state} />
      <pre
        className={cn(
          "overflow-x-auto px-4 pt-1 pb-4 text-[13px] leading-[1.65] text-ink-2",
          !showSource && "sr-only",
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
