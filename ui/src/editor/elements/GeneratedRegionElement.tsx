import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RenderElementProps } from "slate-react";
import {
  ReactEditor,
  useReadOnly,
  useSelected,
  useSlateStatic,
} from "slate-react";
import type { RenderSelection } from "#/api/bases";
import { BaseEmbedInspector } from "#/components/bases/BaseEmbedInspector";
import { BaseRenderedMarkdown } from "#/components/bases/BaseRenderedMarkdown";
import { baseRenderSelection } from "#/components/bases/embed-query";
import { GeneratedPreviewDialog } from "#/components/bases/GeneratedPreviewDialog";
import { TemplateSourceEditor } from "#/components/bases/TemplateSourceEditor";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useBaseEmbedEditing } from "#/editor/baseEmbedEditing";
import { useBaseRendering } from "#/editor/baseRendering";
import { mdastToSlate } from "#/editor/convert/mdast-to-slate";
import type {
  BaseEmbedElement,
  GeneratedRegionElement as RegionNode,
} from "#/editor/schema/types";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const encoder = new TextEncoder();

export function GeneratedRegionElement({
  attributes,
  children,
  element,
}: RenderElementProps & { element: RegionNode }) {
  const editor = useSlateStatic();
  const editing = useBaseEmbedEditing();
  const lifecycle = useBaseRendering();
  const selected = useSelected();
  const readOnly = useReadOnly();
  const editRef = useRef<HTMLButtonElement>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [previewSelection, setPreviewSelection] =
    useState<RenderSelection | null>(null);
  const [repair, setRepair] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const path = ReactEditor.findPath(editor, element);
  const active = editing.isActive(path);
  const payload = element.status === "valid" ? element.payload : null;
  const expectedHash =
    element.status === "valid" ? element.descriptor.output_hash : null;
  const modified = useMemo(
    () =>
      payload !== null &&
      `blake3:${bytesToHex(blake3(encoder.encode(payload)))}` !== expectedHash,
    [payload, expectedHash],
  );
  const selectionNode = useMemo<BaseEmbedElement>(
    () =>
      element.status === "valid"
        ? {
            type: "base-embed",
            status: "configured",
            base: element.descriptor.base,
            template: element.descriptor.template,
            ...(element.descriptor.view === undefined
              ? {}
              : { view: element.descriptor.view }),
            ...(element.descriptor.filter === undefined
              ? {}
              : { filter: element.descriptor.filter }),
            ...(element.descriptor.sort === undefined
              ? {}
              : { sort: element.descriptor.sort }),
            ...(element.descriptor.limit === undefined
              ? {}
              : { limit: element.descriptor.limit }),
            children: [{ text: "" }],
          }
        : {
            type: "base-embed",
            status: "unconfigured",
            children: [{ text: "" }],
          },
    [element],
  );
  const focusHandle = useMemo(
    () => ({
      focusEntry() {
        if (!editRef.current?.isConnected || editRef.current.disabled)
          return false;
        editRef.current.focus();
        return document.activeElement === editRef.current;
      },
      focusEdit() {
        if (!editRef.current?.isConnected || editRef.current.disabled)
          return false;
        editRef.current.focus();
        return document.activeElement === editRef.current;
      },
    }),
    [],
  );
  const { registerEntryFocus, disposeNode } = editing;
  useLayoutEffect(() => {
    const unregister = registerEntryFocus(element, focusHandle);
    return () => {
      unregister();
      disposeNode(element);
    };
  }, [disposeNode, element, focusHandle, registerEntryFocus]);

  function openSelection() {
    editing.begin(ReactEditor.findPath(editor, element));
    if (element.status === "invalid") {
      setRepair(element.rawBlock);
      setRepairError(null);
    }
  }

  function finishRepair() {
    if (repair === null) return;
    const nodes = mdastToSlate(repair).filter(
      (node) =>
        !(
          "generatedRegionTrailingSentinel" in node &&
          node.generatedRegionTrailingSentinel
        ),
    );
    const replacement = nodes[0];
    if (
      nodes.length !== 1 ||
      !replacement ||
      !("type" in replacement) ||
      replacement.type !== "generated-region" ||
      replacement.status !== "valid"
    ) {
      setRepairError(
        "Repair must contain one complete valid generated region. Original bytes are retained until a valid repair is saved.",
      );
      return;
    }
    editing.commit(replacement);
    setRepair(null);
    editing.restoreFocus(path);
  }

  return (
    <div
      {...attributes}
      className={cn(
        "my-4 min-w-0 rounded-[14px] bg-raise transition-shadow",
        (selected || active) && "ring-2 ring-accent",
      )}
      data-testid="generated-region"
    >
      <fieldset
        contentEditable={false}
        className="m-0 min-w-0 border-0 p-0"
        aria-label="Generated region controls"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          editing.exit(ReactEditor.findPath(editor, element), "after");
        }}
      >
        <button
          type="button"
          className="sr-only"
          aria-label="Exit generated region before"
          onClick={() => editing.exit(path, "before")}
          onKeyDown={(event) => {
            if (event.key === "Tab" && event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              editing.exit(path, "before");
            }
          }}
        />
        <header className="flex flex-wrap items-center gap-x-1.5 gap-y-2 px-3.5 pt-3 pb-1">
          <span className="mr-auto text-[12.5px] text-mute">
            Generated snapshot
          </span>
          <Button
            ref={editRef}
            variant="secondary"
            size="sm"
            isDisabled={readOnly}
            {...(element.status === "valid" ? { "aria-expanded": active } : {})}
            className={cn(
              "h-7 rounded-full px-[11px] text-[12.5px] font-normal",
              active &&
                "bg-accent-tint text-accent data-[hovered]:bg-accent-tint",
            )}
            onPress={openSelection}
          >
            {element.status === "valid" ? "Edit selection" : "Repair source"}
          </Button>
          {element.status === "valid" ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 rounded-full px-[11px] text-[12.5px] font-normal"
                onPress={() => setTemplateOpen(true)}
              >
                Edit template
              </Button>
              <a
                className={cn(
                  "rounded-full px-[11px] text-[12.5px] text-accent underline-offset-2 hover:underline",
                  FOCUS_RING_NATIVE,
                )}
                href={`/bases/${encodeURIComponent(element.descriptor.base)}${element.descriptor.view ? `?view=${encodeURIComponent(element.descriptor.view)}` : ""}`}
              >
                Open source
              </a>
              <Button
                variant="secondary"
                size="sm"
                className="h-7 rounded-full px-[11px] text-[12.5px] font-normal"
                isDisabled={readOnly || !lifecycle || lifecycle.readonly}
                onPress={() => setPreviewSelection(element.descriptor)}
              >
                Preview / Regenerate
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-[11px] text-[12.5px] font-normal data-[hovered]:text-hot"
            isDisabled={readOnly}
            onPress={() =>
              editing.remove(ReactEditor.findPath(editor, element), element)
            }
          >
            Remove generated region
          </Button>
        </header>
        {element.status === "valid" ? (
          <div className="px-3.5 pt-2 pb-3.5">
            {modified ? (
              <p
                role="status"
                className="mb-3 rounded-xl bg-hot/10 px-3 py-2 text-[13px] text-hot"
              >
                Generated output was modified outside regeneration. Regenerating
                requires explicit overwrite approval.
              </p>
            ) : null}
            <div className="codex-prose">
              <BaseRenderedMarkdown
                content={element.payload}
                pagePath={lifecycle?.pagePath}
              />
            </div>
          </div>
        ) : (
          <div className="px-3.5 pt-2 pb-3.5">
            <p role="alert" className="text-[13.5px] text-hot">
              Generated region needs source repair: {element.parseError}
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl bg-sink p-3 text-[12.5px] text-ink-2">
              {element.rawBlock}
            </pre>
          </div>
        )}
        <button
          type="button"
          className="sr-only"
          aria-label="Exit generated region after"
          onClick={() => editing.exit(path, "after")}
          onKeyDown={(event) => {
            if (event.key === "Tab" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              editing.exit(path, "after");
            }
          }}
        />
        {element.status === "valid" && active ? (
          <BaseEmbedInspector
            isOpen
            node={selectionNode}
            initialMode="generated"
            onGenerate={(node) =>
              setPreviewSelection(baseRenderSelection(node))
            }
            onSave={editing.commit}
            onCancel={editing.cancel}
            onRestoreFocus={() => editing.restoreFocus(path)}
          />
        ) : null}
        {templateOpen && element.status === "valid" ? (
          <TemplateSourceEditor
            slug={element.descriptor.template}
            selection={element.descriptor}
            pagePath={lifecycle?.pagePath}
            readonly={lifecycle?.readonly}
            onClose={() => setTemplateOpen(false)}
          />
        ) : null}
        {previewSelection && element.status === "valid" ? (
          <GeneratedPreviewDialog
            selection={previewSelection}
            regionId={element.descriptor.id}
            prepare={async () => {
              if (!lifecycle || lifecycle.readonly)
                throw new Error("Open a writable destination page first.");
              return { session: await lifecycle.beginGeneratedChange() };
            }}
            onClose={() => setPreviewSelection(null)}
          />
        ) : null}
        {repair !== null ? (
          <Dialog
            isOpen
            title="Repair generated region source"
            description="Edit the exact stored Markdown, including both marker comments. Nothing is discarded on cancel."
            size="full"
            onOpenChange={(open) => {
              if (!open) {
                setRepair(null);
                editing.cancel();
                editing.restoreFocus(path);
              }
            }}
            footer={
              <>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setRepair(null);
                    editing.cancel();
                    editing.restoreFocus(path);
                  }}
                >
                  Cancel
                </Button>
                <Button variant="primary" onPress={finishRepair}>
                  Save repaired source
                </Button>
              </>
            }
          >
            <label className="block text-[12.5px] text-mute">
              Generated region Markdown
              <textarea
                autoFocus
                rows={20}
                spellCheck={false}
                value={repair}
                onChange={(event) => {
                  setRepair(event.target.value);
                  setRepairError(null);
                }}
                className={cn(
                  "mt-1.5 block w-full resize-y rounded-xl bg-sink p-3 text-[13px] leading-6 text-ink",
                  FOCUS_RING_NATIVE,
                )}
              />
            </label>
            {repairError ? (
              <p role="alert" className="mt-2 text-[12.5px] text-hot">
                {repairError}
              </p>
            ) : null}
          </Dialog>
        ) : null}
      </fieldset>
      {children}
    </div>
  );
}
