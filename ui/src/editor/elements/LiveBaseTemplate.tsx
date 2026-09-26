import { useState } from "react";
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

export function LiveBaseTemplate({
  selection,
}: {
  selection: RenderSelection;
}) {
  const lifecycle = useBaseRendering();
  const rendered = useLiveBaseRender(selection, lifecycle?.pagePath ?? "");
  const [editingTemplate, setEditingTemplate] = useState(false);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onPress={() => setEditingTemplate(true)}
        >
          Edit template
        </Button>
        <a
          className={cn(
            "rounded-[3px] text-[13px] text-accent underline decoration-1 underline-offset-[3px] hover:decoration-2",
            FOCUS_RING_NATIVE,
          )}
          href={`/bases/${encodeURIComponent(selection.base)}${selection.view ? `?view=${encodeURIComponent(selection.view)}` : ""}`}
        >
          Open source
        </a>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => {
            void rendered.refetch();
          }}
          isDisabled={rendered.isFetching || !lifecycle}
        >
          Refresh output
        </Button>
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
