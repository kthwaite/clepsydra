import { type FormEvent, useState } from "react";
import { useQuickCapture } from "#/api/journal";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { useUiStore } from "#/store/ui";

/** One-line aside capture — appends a time-stamped entry to today's journal
 *  from anywhere (⌘⇧D / palette). The server stamps plain prose and creates
 *  the journal if it does not exist yet. */
export function CaptureAsideModal() {
  const isOpen = useUiStore((s) => s.isCaptureAsideOpen);
  const onClose = useUiStore((s) => s.closeCaptureAside);
  const capture = useQuickCapture();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dismiss = () => {
    setText("");
    setError(null);
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setError(null);
    capture.mutate(content, {
      onSuccess: dismiss,
      onError: (err) => setError(err.message),
    });
  };

  return (
    <CodexModalShell
      ariaLabel="Capture aside"
      maxWidthClassName="max-w-[440px]"
      onDismiss={dismiss}
    >
      <form onSubmit={submit}>
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ❦ Aside
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            TODAY'S JOURNAL
          </span>
        </div>
        <div className="px-4 py-3">
          <input
            aria-label="Aside"
            value={text}
            onChange={(e) => setText(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: this single-field capture modal intentionally starts focus at its only text input
            autoFocus
            placeholder="capture an aside …"
            className="cl-mono w-full border border-rule bg-transparent p-1.5 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
          {error && (
            <div className="cl-mono mt-2 text-[11px] text-hot">⁂ {error}</div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="cl-btn" onClick={dismiss}>
              cancel
            </button>
            <button
              type="submit"
              className="cl-btn cl-btn-hot"
              disabled={capture.isPending || !text.trim()}
            >
              {capture.isPending ? "noting…" : "❦ note"}
            </button>
          </div>
        </div>
      </form>
    </CodexModalShell>
  );
}
