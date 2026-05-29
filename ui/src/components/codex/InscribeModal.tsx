import { type FormEvent, useState } from "react";
import { useCreatePage } from "#/api/pages";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useUiStore } from "#/store/ui";

/** Quick-capture "INTAKE" terminal — mounted globally, opened via ⌘N / palette. */
export function InscribeModal() {
  const isOpen = useUiStore((s) => s.isInscribeOpen);
  const onClose = useUiStore((s) => s.closeInscribe);
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const openTab = useOpenTab();

  if (!isOpen) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedPath = path.trim().replace(/^\/+/, "");
    if (!trimmedPath) {
      setError("designation is required");
      return;
    }
    const finalPath = trimmedPath.endsWith(".md")
      ? trimmedPath
      : `${trimmedPath}.md`;
    const tags = tagsInput
      .split(/[, ]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    create.mutate(
      {
        params: { path: { path: finalPath } },
        body: {
          title: title.trim() || undefined,
          tags: tags.length ? tags : undefined,
        },
      },
      {
        onSuccess: () => {
          openTab("page", finalPath, title.trim() || finalPath);
          reset();
          onClose();
        },
        onError: (err) =>
          setError(String((err as { error?: unknown }).error ?? err)),
      },
    );
  };

  const reset = () => {
    setPath("");
    setTitle("");
    setTagsInput("");
    setError(null);
  };

  const dismiss = () => {
    reset();
    onClose();
  };

  return (
    <div
      onMouseDown={dismiss}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[88%] max-w-[520px] border-[1.5px] border-ink bg-paper text-ink shadow-[8px_8px_0_0_var(--color-ink)] font-body"
      >
        {/* terminal header */}
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ▣ Intake
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            FORM CLP-INTAKE-04 / REV.07
          </span>
        </div>

        <div className="px-4 py-3">
          <Field label="01 · Designation">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
              placeholder="ideas/new-page"
              className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            />
          </Field>
          <Field label="02 · Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label="03 · Tags · comma / space separated">
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </Field>
          {error && (
            <div className="cl-mono mb-2 text-[11px] text-hot">⁂ {error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="cl-btn" onClick={dismiss}>
              cancel
            </button>
            <button
              type="submit"
              className="cl-btn cl-btn-hot"
              disabled={create.isPending}
            >
              {create.isPending ? "committing…" : "▣ commit to archive"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-2.5 block">
      <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      {children}
    </label>
  );
}
