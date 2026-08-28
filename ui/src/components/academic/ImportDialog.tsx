import { useId, useState } from "react";
import {
  type ConflictPolicy,
  type ImportResult,
  useImportBibtex,
  useImportDoi,
  useImportIsbn,
  useImportZotero,
} from "#/api/academic";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";

type ImportMode = "bibtex" | "doi" | "isbn" | "zotero";

const MODE_LABEL: Record<ImportMode, string> = {
  bibtex: "BibTeX",
  doi: "DOI",
  isbn: "ISBN",
  zotero: "Zotero",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  return "Import failed.";
}

export function ImportDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const openPage = useOpenTab();
  const importBibtex = useImportBibtex();
  const importDoi = useImportDoi();
  const importIsbn = useImportIsbn();
  const importZotero = useImportZotero();
  const [mode, setMode] = useState<ImportMode>("bibtex");
  const [value, setValue] = useState("");
  const [databasePath, setDatabasePath] = useState("");
  const [collection, setCollection] = useState("");
  const [since, setSince] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [autoCheckpoint, setAutoCheckpoint] = useState(true);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("skip");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending =
    importBibtex.isPending ||
    importDoi.isPending ||
    importIsbn.isPending ||
    importZotero.isPending;

  function changeMode(nextMode: ImportMode) {
    setMode(nextMode);
    setValue("");
    setResults([]);
    setHasSubmitted(false);
    setError(null);
  }

  function showResults(nextResults: ImportResult[]) {
    setResults(nextResults);
    setHasSubmitted(true);
  }

  async function submit() {
    const input = value.trim();
    setError(null);
    setResults([]);
    setHasSubmitted(false);

    try {
      if (mode === "bibtex") {
        if (!input) throw new Error("BibTeX is required.");
        const response = await importBibtex.mutateAsync({
          body: input,
          headers: { "Content-Type": "text/plain" },
          bodySerializer: (body) => body,
        });
        showResults(response.results);
        return;
      }

      if (mode === "doi") {
        if (!/^10\.\d{4,9}\/\S+$/i.test(input)) {
          throw new Error("Enter a complete DOI, such as 10.1000/example.");
        }
        const response = await importDoi.mutateAsync({ body: { doi: input } });
        showResults([response]);
        return;
      }

      if (mode === "isbn") {
        const normalized = input.replace(/[\s-]/g, "");
        if (!/^(?:\d{9}[\dXx]|\d{13})$/.test(normalized)) {
          throw new Error("Enter a valid 10- or 13-digit ISBN.");
        }
        const response = await importIsbn.mutateAsync({
          body: { isbn: input },
        });
        showResults([response]);
        return;
      }

      const response = await importZotero.mutateAsync({
        body: {
          ...(databasePath.trim()
            ? { database_path: databasePath.trim() }
            : {}),
          ...(collection.trim() ? { collection: collection.trim() } : {}),
          ...(since.trim() ? { since: since.trim() } : {}),
          conflict_policy: conflictPolicy,
          dry_run: dryRun,
          auto_checkpoint: autoCheckpoint,
        },
      });
      showResults(response.results);
    } catch (importError) {
      setError(errorMessage(importError));
    }
  }

  const submitLabel =
    mode === "zotero" && dryRun
      ? "Preview Zotero import"
      : `Import ${MODE_LABEL[mode]}`;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !isPending) onClose();
      }}
      title="Import academic works"
      description="Importers deduplicate works by DOI, ISBN, and citation key."
      size="lg"
      isDismissable={!isPending}
      footer={
        <>
          <Button variant="secondary" onPress={onClose} isDisabled={isPending}>
            Close
          </Button>
          <Button
            variant="primary"
            onPress={() => void submit()}
            isDisabled={isPending}
          >
            {isPending ? "Importing…" : submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="Import source"
          selectedKey={mode}
          onSelectionChange={(key) => changeMode(key as ImportMode)}
          isDisabled={isPending}
          className="w-full"
        >
          <SelectItem id="bibtex">BibTeX</SelectItem>
          <SelectItem id="doi">DOI</SelectItem>
          <SelectItem id="isbn">ISBN</SelectItem>
          <SelectItem id="zotero">Zotero</SelectItem>
        </Select>

        {mode === "bibtex" ? (
          <div>
            <label
              htmlFor={`${id}-bibtex`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              BibTeX
            </label>
            <textarea
              id={`${id}-bibtex`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={10}
              disabled={isPending}
              className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:border-ring"
              placeholder="@article{citekey, ...}"
            />
          </div>
        ) : null}

        {mode === "doi" || mode === "isbn" ? (
          <TextField
            label={MODE_LABEL[mode]}
            value={value}
            onChange={setValue}
            placeholder={
              mode === "doi" ? "10.1000/example" : "978-0-262-03384-8"
            }
            isDisabled={isPending}
            autoFocus
          />
        ) : null}

        {mode === "zotero" ? (
          <div className="space-y-3">
            <TextField
              label="Zotero database path"
              value={databasePath}
              onChange={setDatabasePath}
              description="Leave empty to use the configured or standard Zotero location."
              isDisabled={isPending}
            />
            <TextField
              label="Collection"
              value={collection}
              onChange={setCollection}
              description="Optional Zotero collection name."
              isDisabled={isPending}
            />
            <TextField
              label="Changed since"
              value={since}
              onChange={setSince}
              description="Optional timestamp; otherwise the saved checkpoint is used."
              isDisabled={isPending}
            />
            <Select
              label="Conflict policy"
              selectedKey={conflictPolicy}
              onSelectionChange={(key) =>
                setConflictPolicy(key as ConflictPolicy)
              }
              isDisabled={isPending}
              className="w-full"
            >
              <SelectItem id="skip">Skip existing works</SelectItem>
              <SelectItem id="source_wins">Zotero metadata wins</SelectItem>
              <SelectItem id="manual">Report conflicts only</SelectItem>
            </Select>
            <Checkbox
              isSelected={dryRun}
              onChange={setDryRun}
              isDisabled={isPending}
            >
              Dry run — inspect results without writing pages
            </Checkbox>
            <Checkbox
              isSelected={autoCheckpoint}
              onChange={setAutoCheckpoint}
              isDisabled={isPending}
            >
              Use and update the Zotero import checkpoint
            </Checkbox>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {hasSubmitted ? (
          <section
            aria-label="Import results"
            className="border-t border-border pt-3"
          >
            <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Results
            </h3>
            {results.length === 0 ? (
              <p className="cl-marg mt-2">No items to import.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {results.map((result, index) => (
                  <li
                    key={`${result.cite_key}-${result.page_path ?? index}`}
                    className="border border-border px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 break-all font-mono text-xs">
                        {result.cite_key ||
                          result.page_path ||
                          `Item ${index + 1}`}
                      </span>
                      <span className="cl-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {result.status}
                      </span>
                    </div>
                    {result.error ? (
                      <p className="mt-1 text-xs text-destructive">
                        {result.error}
                      </p>
                    ) : null}
                    {result.conflict_detail?.fields.length ? (
                      <dl className="mt-2 space-y-2 border-t border-border pt-2">
                        {result.conflict_detail.fields.map((field) => (
                          <div key={field.field}>
                            <dt className="cl-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                              {field.field}
                            </dt>
                            <dd className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
                              <span>
                                <span className="font-medium">Local:</span>{" "}
                                {field.local_value ?? "—"}
                              </span>
                              <span>
                                <span className="font-medium">Zotero:</span>{" "}
                                {field.source_value ?? "—"}
                              </span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {result.page_path ? (
                      <button
                        type="button"
                        className="mt-1 break-all text-left text-xs text-accent hover:underline"
                        onClick={() =>
                          openPage(
                            "page",
                            result.page_path ?? undefined,
                            result.cite_key ||
                              result.page_path ||
                              "Imported work",
                          )
                        }
                      >
                        {result.page_path}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
