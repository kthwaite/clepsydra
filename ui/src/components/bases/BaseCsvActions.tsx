import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  TextField as AriaTextField,
  FileTrigger,
  Label,
  TextArea,
} from "react-aria-components";
import {
  type BaseCsvMapping,
  type BaseCsvPreviewResponse,
  type BaseCsvQuery,
  type BaseCsvRowOutcome,
  exportBaseCsv,
  getBaseCsvDefinition,
  importBaseCsvRows,
  previewBaseCsv,
} from "#/api/base-csv";
import type { BaseDetailResponse } from "#/api/bases";
import { formatApiError, isApiConflict } from "#/api/error";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export interface BaseCsvActionsProps {
  slug: string;
  view: string;
  query: BaseCsvQuery;
  onImported?: () => void;
}

export function BaseCsvActions(props: BaseCsvActionsProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();

  async function download() {
    if (exporting) return;
    setExporting(true);
    setError(undefined);
    try {
      const blob = await exportBaseCsv(props.slug, props.view, props.query);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${props.slug}-${props.view.replace(/[^a-zA-Z0-9_-]+/g, "-")}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      // Let the browser begin consuming the object URL before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(formatApiError(error, "CSV could not be exported."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        onPress={() => void download()}
        isDisabled={exporting}
      >
        {exporting ? "Exporting…" : "Export CSV"}
      </Button>
      <Button variant="ghost" onPress={() => setOpen(true)}>
        Import CSV
      </Button>
      {error && (
        <p role="alert" className="text-xs text-hot">
          {error}
        </p>
      )}
      <BaseCsvImportDialog
        key={JSON.stringify([props.slug, props.view, props.query.filter])}
        {...props}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const SYSTEM_FIELDS = ["title", "kind", "project", "tags", "aliases"];
const SKIP = "__skip__";
const CUSTOM = "__custom__";

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function BaseCsvImportDialog({
  slug,
  view,
  query,
  onImported,
  isOpen,
  onClose,
}: BaseCsvActionsProps & { isOpen: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [csv, setCsv] = useState("");
  const [definition, setDefinition] = useState<BaseDetailResponse>();
  const [preview, setPreview] = useState<BaseCsvPreviewResponse>();
  const [mappings, setMappings] = useState<BaseCsvMapping[]>([]);
  const [customColumns, setCustomColumns] = useState<number[]>([]);
  const [current, setCurrent] = useState(false);
  const [approved, setApproved] = useState(false);
  const [outcomes, setOutcomes] = useState<BaseCsvRowOutcome[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"file" | "preview" | "import">();
  const working = useRef(false);
  const sourceLocked = outcomes.length > 0;
  const successCount = outcomes.filter(
    (outcome) => outcome.status === "created",
  ).length;
  const failedCount = outcomes.filter(
    (outcome) => outcome.status === "failed",
  ).length;
  const uncertainCount = outcomes.filter(
    (outcome) => outcome.status === "uncertain",
  ).length;
  const canApprove =
    current && preview?.valid === true && preview.rows.length > 0;
  const pendingCount =
    preview?.rows.filter(
      (row) =>
        !outcomes.some(
          (outcome) => outcome.row === row.row && outcome.status !== "failed",
        ),
    ).length ?? 0;
  const targets = [
    ...new Set([
      ...SYSTEM_FIELDS,
      ...(definition?.properties ?? []).map(
        (property) => `prop.${property.key}`,
      ),
      ...(preview?.declarations ?? []).map(
        (property) => `prop.${property.key}`,
      ),
      ...mappings.flatMap((mapping) => (mapping.field ? [mapping.field] : [])),
    ]),
  ];

  function invalidatePreview() {
    setCurrent(false);
    setApproved(false);
    setError(undefined);
  }

  function changeCsv(value: string) {
    setCsv(value);
    setMappings([]);
    setCustomColumns([]);
    setPreview(undefined);
    invalidatePreview();
  }

  function changeMapping(column: number, field: string | null) {
    setMappings((rows) =>
      rows.map((mapping) =>
        mapping.column === column ? { ...mapping, field } : mapping,
      ),
    );
    invalidatePreview();
  }

  async function readFile(files: FileList | null) {
    const file = files?.[0];
    if (!file || working.current) return;
    working.current = true;
    setBusy("file");
    try {
      changeCsv(await file.text());
    } catch (error) {
      setError(
        formatApiError(
          error,
          "This file could not be read. Paste its CSV content instead.",
        ),
      );
    } finally {
      setBusy(undefined);
      working.current = false;
    }
  }

  async function review() {
    if (working.current || !csv.trim()) return;
    working.current = true;
    setBusy("preview");
    invalidatePreview();
    try {
      const latest = await getBaseCsvDefinition(slug);
      setDefinition(latest);
      const result = await previewBaseCsv(slug, view, {
        base_revision: latest.revision,
        csv,
        mappings: mappings.length
          ? mappings.map(({ column, field }) => ({ column, field }))
          : undefined,
        embed_filter: query.filter,
      });
      setPreview(result);
      setMappings(result.mappings);
      setCurrent(true);
    } catch (error) {
      setError(formatApiError(error, "CSV could not be previewed."));
    } finally {
      setBusy(undefined);
      working.current = false;
    }
  }

  async function apply() {
    if (
      working.current ||
      !canApprove ||
      !approved ||
      !preview ||
      !definition ||
      pendingCount === 0
    )
      return;
    working.current = true;
    setBusy("import");
    setError(undefined);
    try {
      await importBaseCsvRows(
        {
          slug,
          view,
          definition,
          preview,
          approved,
          embedFilter: query.filter,
          previous: outcomes,
          onOutcome: (outcome) =>
            setOutcomes((rows) =>
              [
                ...rows.filter((entry) => entry.row !== outcome.row),
                outcome,
              ].sort((a, b) => a.row - b.row),
            ),
        },
        client,
      );
    } catch (error) {
      setError(
        isApiConflict(error)
          ? "The Base definition changed. No further rows were attempted. Preview again to review the latest schema before retrying."
          : formatApiError(
              error,
              "CSV could not be imported. Preview again before retrying.",
            ),
      );
    } finally {
      setCurrent(false);
      setApproved(false);
      setBusy(undefined);
      working.current = false;
      onImported?.();
    }
  }

  function reset() {
    changeCsv("");
    setOutcomes([]);
    setDefinition(undefined);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !working.current) onClose();
      }}
      title="Import CSV"
      description="Map columns, review inferred types and diagnostics, then approve the import."
      size="full"
      isDismissable={!busy}
      isCloseDisabled={!!busy}
      footer={
        <>
          <Button variant="secondary" onPress={onClose} isDisabled={!!busy}>
            Close
          </Button>
          <Button
            variant="secondary"
            onPress={() => void review()}
            isDisabled={!!busy || !csv.trim()}
          >
            {busy === "preview" ? "Previewing…" : "Preview CSV"}
          </Button>
          <Button
            variant="primary"
            onPress={() => void apply()}
            isDisabled={
              !!busy || !canApprove || !approved || pendingCount === 0
            }
          >
            {busy === "import"
              ? "Importing…"
              : sourceLocked
                ? "Retry failed rows"
                : "Import rows"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className="text-sm text-mute">
          No pages or property declarations are written by preview. Import
          creates new pages; it does not update existing pages. Read-only system
          columns (such as ID, path, and timestamps) are ignored by automatic
          mapping. Skipped columns are listed below. Page bodies and row
          templates are not imported.
        </p>
        <FileTrigger
          acceptedFileTypes={[".csv", "text/csv"]}
          onSelect={(files) => void readFile(files)}
        >
          <Button variant="secondary" isDisabled={!!busy || sourceLocked}>
            {busy === "file" ? "Reading…" : "Choose CSV file"}
          </Button>
        </FileTrigger>
        <AriaTextField
          value={csv}
          onChange={changeCsv}
          isDisabled={!!busy || sourceLocked}
          className="flex flex-col gap-2"
        >
          <Label className="text-sm text-mute">CSV content</Label>
          <TextArea
            rows={6}
            className={cn(
              "w-full resize-y rounded-xl bg-sink p-3 text-sm text-ink disabled:opacity-60",
              FOCUS_RING,
            )}
          />
        </AriaTextField>
        {mappings.length > 0 && (
          <section aria-label="Column mapping" className="space-y-3">
            <h3 className="font-serif text-xl italic text-ink">
              Column mapping
            </h3>
            <p className="text-sm text-mute">
              Suggestions match headers without case sensitivity. Choose a
              field, skip a column, or enter a new property name. Changes
              require another preview.
            </p>
            {mappings.map((mapping) => (
              <div
                key={mapping.column}
                className="grid gap-2 rounded-xl bg-ground p-3 sm:grid-cols-2"
              >
                <Select
                  label={`Map column ${mapping.column + 1}: ${mapping.header}`}
                  value={
                    customColumns.includes(mapping.column)
                      ? CUSTOM
                      : (mapping.field ?? SKIP)
                  }
                  onChange={(key) => {
                    if (key === CUSTOM) {
                      setCustomColumns((columns) => [
                        ...columns,
                        mapping.column,
                      ]);
                      invalidatePreview();
                    } else {
                      setCustomColumns((columns) =>
                        columns.filter((column) => column !== mapping.column),
                      );
                      changeMapping(
                        mapping.column,
                        key === SKIP || key === null ? null : String(key),
                      );
                    }
                  }}
                  isDisabled={!!busy || sourceLocked}
                >
                  <SelectItem id={SKIP}>Skip / ignore this column</SelectItem>
                  {targets.map((target) => (
                    <SelectItem key={target} id={target}>
                      {target}
                    </SelectItem>
                  ))}
                  <SelectItem id={CUSTOM}>Custom property name…</SelectItem>
                </Select>
                {customColumns.includes(mapping.column) && (
                  <TextField
                    label={`Property for ${mapping.header}`}
                    value={mapping.field ?? ""}
                    onChange={(value) => changeMapping(mapping.column, value)}
                    isDisabled={!!busy || sourceLocked}
                    description="Use prop.name for a custom property; its type is inferred on preview."
                  />
                )}
                {mapping.field === null && (
                  <p className="text-sm text-mute">
                    Ignored: {mapping.header || `column ${mapping.column + 1}`}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}
        {preview && (
          <>
            {!current && (
              <p role="status" className="text-sm text-mute">
                Preview again before importing. Successful rows will not be
                created again.
              </p>
            )}
            {preview.declarations.length > 0 && (
              <section aria-label="Proposed properties" className="space-y-2">
                <h3 className="font-serif text-xl italic text-ink">
                  Proposed properties
                </h3>
                <ul className="space-y-1 text-sm">
                  {preview.declarations.map((property) => (
                    <li key={property.key}>
                      {property.key}: {property.definition.type}
                      {property.definition.options?.length
                        ? ` (${property.definition.options.join("; ")})`
                        : ""}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-mute">
                  Approval adds these declarations to the Base before any pages
                  are created. Existing page values are unchanged.
                </p>
              </section>
            )}
            {preview.diagnostics.length > 0 && (
              <section aria-label="CSV diagnostics" className="space-y-2">
                <h3 className="font-serif text-xl italic text-ink">
                  Import blocked
                </h3>
                <ul className="space-y-1 text-sm text-hot">
                  {preview.diagnostics.map((diagnostic) => (
                    <li key={JSON.stringify(diagnostic)}>
                      {diagnostic.row != null ? `Row ${diagnostic.row}: ` : ""}
                      {diagnostic.field ? `${diagnostic.field}: ` : ""}
                      {diagnostic.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="max-h-80 overflow-auto rounded-xl bg-ground p-3">
              <table className="w-full text-left text-sm">
                <caption className="pb-3 text-left text-mute">
                  Preview: {preview.rows.length} rows. All rows must validate
                  before import.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-2">
                      CSV row
                    </th>
                    <th scope="col" className="p-2">
                      Title
                    </th>
                    <th scope="col" className="p-2">
                      Fields
                    </th>
                    <th scope="col" className="p-2">
                      Diagnostics
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row}>
                      <th scope="row" className="p-2 font-normal">
                        {row.row}
                      </th>
                      <td className="p-2">
                        {row.title || "From title template"}
                      </td>
                      <td className="p-2">
                        {Object.entries(row.fields).map(([key, value]) => (
                          <div key={key}>
                            {key}: {displayValue(value)}
                          </div>
                        ))}
                      </td>
                      <td className="p-2">
                        {row.diagnostics.length
                          ? row.diagnostics
                              .map((diagnostic) => diagnostic.message)
                              .join("; ")
                          : "Valid"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Checkbox
              isSelected={approved}
              onChange={setApproved}
              isDisabled={!!busy || !canApprove || pendingCount === 0}
            >
              {preview.declarations.length > 0
                ? "I approve these new property declarations and the valid rows for import"
                : "I approve these valid rows for import"}
            </Checkbox>
          </>
        )}
        {outcomes.length > 0 && (
          <section aria-label="Import outcomes" className="space-y-3">
            <h3 className="font-serif text-xl italic text-ink">
              Import outcomes
            </h3>
            <p role="status">
              {successCount} created · {failedCount} failed · {uncertainCount}{" "}
              uncertain
            </p>
            <ul className="space-y-2 text-sm">
              {outcomes.map((outcome) => (
                <li key={outcome.row}>
                  Row {outcome.row}:{" "}
                  {outcome.status === "created"
                    ? `Created ${outcome.page.title} (${outcome.page.path})`
                    : `${outcome.status === "uncertain" ? "Uncertain" : "Failed"} — ${outcome.message}`}
                </li>
              ))}
            </ul>
            <p className="text-sm text-mute">
              Preview again to retry confirmed failures. Successful and
              uncertain rows are never retried. CSV content and mappings stay
              locked for this import so retry cannot duplicate successful rows.
            </p>
            <Button variant="secondary" onPress={reset} isDisabled={!!busy}>
              Start another import
            </Button>
          </section>
        )}
        {error && (
          <p role="alert" className="text-sm text-hot">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
