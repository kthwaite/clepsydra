import { type ReactNode, useState } from "react";
import { type RenderSelection, useLiveBaseRender } from "#/api/bases";
import { BaseRenderedMarkdown } from "#/components/bases/BaseRenderedMarkdown";
import {
  renderErrorMessage,
  TemplateSourceEditor,
} from "#/components/bases/TemplateSourceEditor";
import { Button } from "#/components/ui/button";
import { useBaseRendering } from "#/editor/baseRendering";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const quietControl = "h-7 rounded-full px-[11px] text-[12.5px] font-normal";

/**
 * A template-rendered Base reads as part of the note: its controls sit in one
 * quiet row that comes up to full strength on hover or keyboard focus.
 */
export function LiveBaseTemplate({
  selection,
  actions,
}: {
  selection: RenderSelection;
  /** The embed's own controls (Edit embed, Remove), placed in the same row. */
  actions?: ReactNode;
}) {
  const lifecycle = useBaseRendering();
  const rendered = useLiveBaseRender(selection, lifecycle?.pagePath ?? "");
  const [editingTemplate, setEditingTemplate] = useState(false);
  return (
    <div>
      <div
        role="toolbar"
        aria-label="Rendered Base"
        className="mb-2 flex flex-wrap items-center gap-1 text-mute opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="mr-1 min-w-0 truncate text-[12.5px]">
          {selection.base}
          {selection.view ? ` · ${selection.view}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={quietControl}
          onPress={() => setEditingTemplate(true)}
        >
          Edit template
        </Button>
        <a
          className={cn(
            "rounded-full px-[11px] text-[12.5px] leading-7 text-mute underline decoration-1 underline-offset-[3px] hover:text-accent hover:decoration-2",
            FOCUS_RING_NATIVE,
          )}
          href={`/bases/${encodeURIComponent(selection.base)}${selection.view ? `?view=${encodeURIComponent(selection.view)}` : ""}`}
        >
          Open source
        </a>
        <Button
          variant="ghost"
          size="sm"
          className={quietControl}
          onPress={() => {
            void rendered.refetch();
          }}
          isDisabled={rendered.isFetching || !lifecycle}
        >
          Refresh output
        </Button>
        {actions}
      </div>
      {!lifecycle ? (
        <p role="alert" className="text-[14px] text-ink-2">
          Open this embed in its destination page to render its template.
        </p>
      ) : null}
      {rendered.isFetching ? (
        <p role="status" className="text-[12.5px] text-mute">
          Rendering live Markdown…
        </p>
      ) : null}
      {rendered.error ? (
        <p role="alert" className="text-[14px] text-hot">
          {renderErrorMessage(rendered.error)}
        </p>
      ) : null}
      {rendered.data ? (
        <div className="codex-prose">
          <BaseRenderedMarkdown
            content={rendered.data.markdown}
            pagePath={lifecycle?.pagePath}
          />
          <p className="mt-3 text-[12.5px] tabular-nums text-mute">
            Live · {rendered.data.selected_count} records
            {rendered.data.limit != null
              ? ` · limit ${rendered.data.limit}`
              : ""}
          </p>
        </div>
      ) : null}
      {editingTemplate ? (
        <TemplateSourceEditor
          slug={selection.template}
          selection={selection}
          pagePath={lifecycle?.pagePath}
          readonly={lifecycle?.readonly}
          onSaved={() => {
            void rendered.refetch();
          }}
          onClose={() => setEditingTemplate(false)}
        />
      ) : null}
    </div>
  );
}
