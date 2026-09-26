import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  applyGeneratedRegion,
  type GeneratedPreview,
  previewGeneratedRegion,
  type RenderSelection,
} from "#/api/bases";
import { invalidatePageContent } from "#/api/keys";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import type { GeneratedChangeSession } from "#/editor/usePageEditor";
import { BaseRenderedMarkdown } from "./BaseRenderedMarkdown";
import { renderErrorMessage } from "./TemplateSourceEditor";

export interface PreparedGeneratedChange {
  session: GeneratedChangeSession;
  insertOffset?: number;
}

interface GeneratedPreviewDialogProps {
  selection: RenderSelection;
  regionId?: string;
  prepare(): Promise<PreparedGeneratedChange>;
  onClose(): void;
}

export function GeneratedPreviewDialog({
  selection,
  regionId,
  prepare,
  onClose,
}: GeneratedPreviewDialogProps) {
  const queryClient = useQueryClient();
  const session = useRef<GeneratedChangeSession | null>(null);
  const request = useRef(0);
  const [preview, setPreview] = useState<GeneratedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pagePath, setPagePath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  useEffect(
    () => () => {
      request.current += 1;
      session.current?.cancel();
    },
    [],
  );

  async function previewOutput() {
    const generation = ++request.current;
    session.current?.cancel();
    session.current = null;
    setBusy(true);
    setError(null);
    setPreview(null);
    setOverwrite(false);
    try {
      const prepared = await prepare();
      if (generation !== request.current) {
        prepared.session.cancel();
        return;
      }
      session.current = prepared.session;
      const result = await previewGeneratedRegion({
        page_path: prepared.session.pagePath,
        expected_revision: prepared.session.revision,
        selection,
        ...(regionId
          ? { region_id: regionId }
          : { insert_offset: prepared.insertOffset }),
      });
      if (generation === request.current) {
        setPagePath(prepared.session.pagePath);
        setPreview(result);
      }
    } catch (failure) {
      if (generation !== request.current) return;
      session.current?.cancel(failure);
      session.current = null;
      setError(renderErrorMessage(failure));
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }

  async function apply() {
    const current = session.current;
    if (!preview || !current || (preview.modified && !overwrite)) return;
    setBusy(true);
    setApplying(true);
    try {
      await current.apply(() =>
        applyGeneratedRegion({
          token: preview.token,
          overwrite_modified: overwrite,
        }),
      );
      session.current = null;
      invalidatePageContent(queryClient, current.pagePath);
      onClose();
    } catch (failure) {
      session.current = null;
      setPreview(null);
      setOverwrite(false);
      setError(
        `${renderErrorMessage(failure)} Preview again before applying. If the destination changed, close this dialog and reload its latest revision first.`,
      );
    } finally {
      setBusy(false);
      setApplying(false);
    }
  }

  function close() {
    if (applying) return;
    request.current += 1;
    session.current?.cancel();
    session.current = null;
    onClose();
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={regionId ? "Preview regeneration" : "Preview generated region"}
      size="full"
      isCloseDisabled={applying}
      isDismissable={false}
      description="Apply publishes exactly this reviewed snapshot, even if source records change later. The destination stays locked while the preview is open."
      footer={
        <>
          <Button variant="secondary" onPress={close} isDisabled={applying}>
            Cancel
          </Button>
          <Button variant="secondary" onPress={previewOutput} isDisabled={busy}>
            {preview || error ? "Preview again" : "Render preview"}
          </Button>
          <Button
            variant="primary"
            onPress={apply}
            isDisabled={busy || !preview || (preview.modified && !overwrite)}
          >
            Apply reviewed snapshot
          </Button>
        </>
      }
    >
      {busy ? (
        <p role="status" className="text-[13.5px] text-mute">
          {applying
            ? "Applying reviewed snapshot…"
            : "Saving pending edits and rendering preview…"}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-hot/10 px-3 py-2 text-[13px] text-hot"
        >
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="grid gap-4">
          <p className="text-[12.5px] text-mute">
            {preview.selected_count} selected records. This is a previewed
            snapshot, not a live view.
          </p>
          {preview.modified ? (
            <div className="rounded-xl bg-hot/10 p-3.5">
              <p role="alert" className="text-[13.5px] text-hot">
                The saved output was edited outside regeneration. Applying will
                replace those edits.
              </p>
              <label className="mt-3 flex items-center gap-2.5 text-[14px] text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-accent"
                  checked={overwrite}
                  onChange={(event) => setOverwrite(event.target.checked)}
                />
                I reviewed the current output and approve replacing its external
                edits.
              </label>
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="Current generated output">
              <h3 className="mb-2.5 flex items-center gap-2.5">
                <Tick variant="faint" />
                <span className="font-serif text-[19px] italic leading-tight text-ink">
                  Current output
                </span>
              </h3>
              <div className="codex-prose rounded-xl bg-ground p-4">
                <BaseRenderedMarkdown
                  content={
                    preview.current_markdown || "No generated output yet."
                  }
                  pagePath={pagePath}
                />
              </div>
            </section>
            <section aria-label="Proposed generated output">
              <h3 className="mb-2.5 flex items-center gap-2.5">
                <Tick variant="live" />
                <span className="font-serif text-[19px] italic leading-tight text-ink">
                  Proposed output
                </span>
              </h3>
              <div className="codex-prose rounded-xl bg-ground p-4">
                <BaseRenderedMarkdown
                  content={preview.markdown}
                  pagePath={pagePath}
                />
              </div>
            </section>
          </div>
        </div>
      ) : (
        <p className="text-[13.5px] text-mute">
          Render a preview from the saved template. No output is written until
          you apply.
        </p>
      )}
    </Dialog>
  );
}
