import { ScanBarcode } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useImportIsbn } from "#/api/academic";
import { formatApiError } from "#/api/error";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";
import { normalizeIsbn } from "#/lib/isbn";
import { useUiStore } from "#/store/ui";
import { BookBarcodeScanner } from "./BookBarcodeScanner";

export function BookImportModal() {
  const isOpen = useUiStore((state) => state.isBookImportOpen);
  const onClose = useUiStore((state) => state.closeBookImport);
  const importIsbn = useImportIsbn();
  const openTab = useOpenTab();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isbn, setIsbn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const reset = () => {
    setIsbn("");
    setError(null);
    setIsScanning(false);
    setScanMessage(null);
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
      panelClassName="rounded-[18px]"
      onDismiss={dismiss}
    >
      <form
        onSubmit={submit}
        className="flex flex-col gap-5 px-6 py-7 md:px-8 md:pt-[30px] md:pb-7"
      >
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic leading-none text-mute">
              ISBN · Open Library
            </span>
          </span>
          <h2 className="font-serif text-[32px] font-normal leading-[1.1] text-ink">
            Add book
          </h2>
        </div>

        <div className="flex flex-col gap-2">
          <TextField
            id="book-import-isbn"
            autoComplete="off"
            description="Metadata is retrieved from Open Library. Review the book page after import."
            inputMode="text"
            inputRef={inputRef}
            isInvalid={error ? true : undefined}
            label="ISBN-10 or ISBN-13"
            onChange={(value) => {
              setIsbn(value);
              if (error) setError(null);
              if (scanMessage) setScanMessage(null);
            }}
            placeholder="978-0-262-01153-2"
            value={isbn}
          />

          {scanMessage ? (
            <p className="text-[13px] text-mute" role="status">
              {scanMessage}
            </p>
          ) : null}

          {error ? (
            <p className="text-[13.5px] text-hot" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        {isScanning ? (
          <BookBarcodeScanner
            onCancel={() => {
              setIsScanning(false);
              inputRef.current?.focus();
            }}
            onCapture={(normalized) => {
              setIsbn(normalized);
              setError(null);
              setIsScanning(false);
              setScanMessage("Barcode captured. Choose Add book to import it.");
              inputRef.current?.focus();
            }}
          />
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isScanning ? null : (
            <Button
              isDisabled={importIsbn.isPending}
              onPress={() => {
                setError(null);
                setScanMessage(null);
                setIsScanning(true);
              }}
              type="button"
              variant="secondary"
            >
              <ScanBarcode aria-hidden className="size-4" strokeWidth={1.7} />
              Scan barcode
            </Button>
          )}
          <span className="grow" />
          <Button onPress={dismiss} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            isDisabled={importIsbn.isPending}
            type="submit"
            variant="primary"
          >
            {importIsbn.isPending ? "Adding book…" : "Add book"}
          </Button>
        </div>
      </form>
    </CodexModalShell>
  );
}
