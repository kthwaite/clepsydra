import { useEffect, useRef, useState } from "react";
import {
  type RenderSelection,
  renderBase,
  type TemplateDocument,
  useBaseTemplate,
  useCreateBaseTemplate,
  useUpdateBaseTemplate,
} from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { BaseRenderedMarkdown } from "./BaseRenderedMarkdown";

export function renderErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  )
    return error.error;
  return "The operation failed. Your draft has been kept. Retry when the server is available.";
}

interface TemplateSourceEditorProps {
  slug?: string;
  selection?: RenderSelection;
  pagePath?: string;
  readonly?: boolean;
  onSaved?(slug: string): void;
  onClose(): void;
}

export function TemplateSourceEditor({
  slug,
  selection,
  pagePath,
  readonly = false,
  onSaved,
  onClose,
}: TemplateSourceEditorProps) {
  const query = useBaseTemplate(slug ?? "");
  const create = useCreateBaseTemplate();
  const update = useUpdateBaseTemplate();
  const online = useOnlineStatus();
  const [name, setName] = useState(slug ?? "");
  const [document, setDocument] = useState<TemplateDocument | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    if (document || !query.data) return;
    setDocument(query.data);
    setSource(query.data.source);
  }, [document, query.data]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const saving = create.isPending || update.isPending;
  const unavailable = readonly || !online || saving || (!!slug && !document);
  const dirty = document
    ? source !== document.source
    : source !== "" || name !== "";

  async function save() {
    if (unavailable || !name.trim()) return;
    setError(null);
    try {
      const saved = document
        ? await update.mutateAsync({
            params: { path: { slug: document.slug } },
            body: { source, expected_revision: document.revision },
          })
        : await create.mutateAsync({
            params: { path: { slug: name.trim() } },
            body: { source },
          });
      setDocument(saved);
      setName(saved.slug);
      onSaved?.(saved.slug);
    } catch (failure) {
      setError(renderErrorMessage(failure));
    }
  }

  async function previewDraft() {
    if (!selection || !pagePath || !online) return;
    const generation = ++request.current;
    setError(null);
    setPreview(null);
    setPreviewPending(true);
    try {
      const rendered = await renderBase({
        selection: { ...selection, template: name.trim() || "draft" },
        page_path: pagePath,
        template_source: source,
      });
      if (generation === request.current) setPreview(rendered.markdown);
    } catch (failure) {
      if (generation === request.current) setError(renderErrorMessage(failure));
    } finally {
      if (generation === request.current) setPreviewPending(false);
    }
  }

  async function reload() {
    const latest = await query.refetch();
    if (!latest.data) {
      setError(renderErrorMessage(latest.error));
      return;
    }
    request.current += 1;
    setDocument(latest.data);
    setSource(latest.data.source);
    setError(null);
    setPreview(null);
    setPreviewPending(false);
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={slug ? `Edit template: ${slug}` : "Create Base template"}
      size="full"
      isDismissable={false}
      isCloseDisabled={saving}
      description="MiniJinja source in .clepsydra/templates. Draft previews never write generated output."
      footer={
        <>
          <Button variant="secondary" onPress={onClose} isDisabled={saving}>
            {dirty ? "Discard draft and close" : "Close"}
          </Button>
          <Button
            variant="primary"
            onPress={save}
            isDisabled={unavailable || !name.trim()}
          >
            Save template
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <label className="text-xs font-bold uppercase tracking-widest">
          Template name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!!document || !!slug || saving || readonly}
            className="mt-1 block w-full border border-input bg-background p-2 text-sm normal-case tracking-normal"
          />
        </label>
        <p className="text-xs text-muted-foreground">{`.clepsydra/templates/${name || "<name>"}.md.jinja`}</p>
        <label className="text-xs font-bold uppercase tracking-widest">
          Template source
          <textarea
            autoFocus
            rows={16}
            value={source}
            disabled={unavailable}
            spellCheck={false}
            onChange={(event) => {
              request.current += 1;
              setSource(event.target.value);
              setPreview(null);
              setPreviewPending(false);
            }}
            className="mt-1 block w-full resize-y border border-input bg-background p-3 font-mono text-sm font-normal normal-case tracking-normal"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Use page, rows and groups. Record properties are native values; body
          contains the full Markdown. Guard optional values with is defined or
          default.
        </p>
        {query.error ? (
          <p role="alert">{renderErrorMessage(query.error)}</p>
        ) : null}
        {error ? (
          <div role="alert" className="text-sm text-destructive">
            <p>{error}</p>
            {slug ? (
              <Button variant="secondary" onPress={reload}>
                Discard draft and reload latest template
              </Button>
            ) : null}
          </div>
        ) : null}
        {!online ? (
          <p role="status">
            Offline: saved source can be read, but saving and preview are
            unavailable.
          </p>
        ) : null}
        <Button
          variant="secondary"
          onPress={previewDraft}
          isDisabled={!selection || !pagePath || !online || previewPending}
        >
          Preview draft
        </Button>
        {previewPending ? <p role="status">Rendering draft…</p> : null}
        {preview !== null ? (
          <section
            aria-label="Draft render preview"
            className="codex-prose border border-border p-4"
          >
            <BaseRenderedMarkdown content={preview} pagePath={pagePath} />
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
