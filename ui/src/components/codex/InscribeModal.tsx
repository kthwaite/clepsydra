import { type FormEvent, useState } from "react";
import { useCreatePage } from "#/api/pages";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = { onClose: () => void };

export function InscribeModal({ onClose }: Props) {
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const openTab = useOpenTab();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedPath = path.trim().replace(/^\/+/, "");
    if (!trimmedPath) {
      setError("path is required");
      return;
    }
    const finalPath = trimmedPath.endsWith(".md") ? trimmedPath : `${trimmedPath}.md`;
    const tags = tagsInput
      .split(/[, ]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    create.mutate(
      {
        params: { path: { path: finalPath } },
        body: { title: title.trim() || undefined, tags: tags.length ? tags : undefined },
      },
      {
        onSuccess: () => {
          openTab("page", finalPath, title.trim() || finalPath);
          onClose();
        },
        onError: (err) => setError(String((err as { error?: unknown }).error ?? err)),
      },
    );
  };

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 80,
      }}
    >
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          width: "88%",
          maxWidth: 520,
          background: "var(--paper)",
          color: "var(--ink)",
          border: "1.5px solid var(--ink)",
          boxShadow: "8px 8px 0 0 var(--ink)",
          padding: 14,
        }}
      >
        <div className="cl-cap mb-2" style={{ fontSize: 11 }}>
          Inscribe a new folio
        </div>
        <label
          className="cl-mono mb-2 block"
          style={{ fontSize: 10, color: "var(--ink-mute)" }}
        >
          path · vault-relative, .md optional
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
            placeholder="ideas/new-page"
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        <label
          className="cl-mono mb-2 block"
          style={{ fontSize: 10, color: "var(--ink-mute)" }}
        >
          title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        <label
          className="cl-mono mb-3 block"
          style={{ fontSize: 10, color: "var(--ink-mute)" }}
        >
          tags · comma or space separated
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        {error && (
          <div className="cl-marg" style={{ color: "var(--accent-deep)", marginBottom: 8 }}>
            ⁂ {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="cl-btn" onClick={onClose}>
            cancel
          </button>
          <button type="submit" className="cl-btn cl-btn-hot" disabled={create.isPending}>
            {create.isPending ? "inscribing…" : "inscribe"}
          </button>
        </div>
      </form>
    </div>
  );
}
