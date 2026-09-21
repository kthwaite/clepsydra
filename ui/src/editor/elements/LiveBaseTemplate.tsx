import { useState } from "react";
import { type RenderSelection, useLiveBaseRender } from "#/api/bases";
import { BaseRenderedMarkdown } from "#/components/bases/BaseRenderedMarkdown";
import {
  renderErrorMessage,
  TemplateSourceEditor,
} from "#/components/bases/TemplateSourceEditor";
import { Button } from "#/components/ui/button";
import { useBaseRendering } from "#/editor/baseRendering";

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
          className="font-mono text-xs underline"
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
        <p role="alert">
          Open this embed in its destination page to render its template.
        </p>
      ) : null}
      {rendered.isFetching ? (
        <p role="status" className="text-xs text-muted-foreground">
          Rendering live Markdown…
        </p>
      ) : null}
      {rendered.error ? (
        <p role="alert" className="text-sm text-destructive">
          {renderErrorMessage(rendered.error)}
        </p>
      ) : null}
      {rendered.data ? (
        <div className="codex-prose">
          <BaseRenderedMarkdown
            content={rendered.data.markdown}
            pagePath={lifecycle?.pagePath}
          />
          <p className="mt-3 font-mono text-[10px] text-muted-foreground">
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
