import { type FormEvent, useState } from "react";
import { useImportIsbn } from "#/api/academic";
import { formatApiError } from "#/api/error";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { useOpenTab } from "#/hooks/useOpenTab";
import { normalizeIsbn } from "#/lib/isbn";
import { useUiStore } from "#/store/ui";

export function BookImportModal() {
  const isOpen = useUiStore((state) => state.isBookImportOpen);
  const onClose = useUiStore((state) => state.closeBookImport);
  const importIsbn = useImportIsbn();
  const openTab = useOpenTab();
  const [isbn, setIsbn] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setIsbn("");
    setError(null);
  };

  const dismiss = () => {
    reset();
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeIsbn(isbn);
    if (!normalized) {
      setError("Enter a valid ISBN-10 or ISBN-13");
      return;
    }

    setError(null);
    importIsbn.mutate(
      { body: { isbn: normalized } },
      {
        onSuccess: (result) => {
          if (!result.page_path) {
            setError("The imported book did not include a page path");
            return;
          }
          openTab("page", result.page_path, "Imported book");
          dismiss();
        },
        onError: (cause) =>
          setError(formatApiError(cause, "Unable to import this book")),
      },
    );
  };

  return (
    <CodexModalShell
      ariaLabel="Add book"
      maxWidthClassName="max-w-[480px]"
      onDismiss={dismiss}
    >
      <form onSubmit={submit}>
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ▣ Add book
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            ISBN / OPEN LIBRARY
          </span>
        </div>

        <div className="px-4 py-3">
          <label
            className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute"
            htmlFor="book-import-isbn"
          >
            ISBN-10 or ISBN-13
          </label>
          <input
            id="book-import-isbn"
            aria-label="ISBN"
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            autoFocus
            className="cl-mono mt-1 w-full border border-rule bg-transparent p-1.5 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            inputMode="numeric"
            onChange={(event) => {
              setIsbn(event.target.value);
              if (error) setError(null);
            }}
            placeholder="978-0-262-01153-2"
            value={isbn}
          />
          <p className="cl-mono mt-1.5 text-[9px] leading-relaxed text-ink-mute">
            Metadata is retrieved from Open Library. Review the book page after
            import.
          </p>

          {error ? (
            <div className="cl-mono mt-2 text-[11px] text-hot" role="alert">
              ⁂ {error}
            </div>
          ) : null}

          <div className="mt-3 flex justify-end gap-2">
            <button className="cl-btn" onClick={dismiss} type="button">
              cancel
            </button>
            <button
              className="cl-btn cl-btn-hot"
              disabled={importIsbn.isPending}
              type="submit"
            >
              {importIsbn.isPending ? "Adding book…" : "Add book"}
            </button>
          </div>
        </div>
      </form>
    </CodexModalShell>
  );
}
