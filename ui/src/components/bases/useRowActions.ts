import { useCallback, useState } from "react";
import {
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCapability,
  decodeBaseMemberDiagnostics,
  type QueryOutput,
  type QueryRow,
  useCreateBaseMember,
} from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError, isApiConflict } from "#/api/error";
import { useArchivePage } from "#/api/pages";
import type { components } from "#/api/schema";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";
import { useOpenTab } from "#/hooks/useOpenTab";
import { type CellValue, formatCellValue } from "./cells/types";
import { outputContains } from "./query-output";

type PageBaseProperty = components["schemas"]["PageBaseProperty"];

/** The filename minus its `.md` extension, for an untitled row's fallbacks. */
function pathStem(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

/** `[[Title]]`, or `[[stem]]` when the row has no title. */
export function wikilinkFor(row: QueryRow): string {
  return `[[${row.title ?? pathStem(row.path)}]]`;
}

/**
 * Compose the `fields` payload for duplicating a row through the member
 * endpoint: capability-fixed implications, then declared present non-null
 * property values (these can override an implication, e.g. a fixed field the
 * row happens to match), then `kind`, then `project` when set, then `tags`
 * when non-empty. `aliases` is never carried over.
 */
export function duplicateFields(
  capability: BaseMemberCapability | undefined,
  properties: PageBaseProperty[],
  row: QueryRow,
  tags: string[] | null | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const requirement of capability?.fields ?? []) {
    if (requirement.implied?.kind === "fixed") {
      fields[requirement.field] = requirement.implied.value;
    }
  }
  for (const property of properties) {
    if (
      property.present &&
      property.value !== null &&
      property.value !== undefined
    ) {
      fields[property.key] = property.value;
    }
  }
  fields.kind = row.kind;
  if (row.project) fields.project = row.project;
  if (tags && tags.length > 0) fields.tags = tags;
  return fields;
}

export interface RowActionsOptions {
  slug: string;
  activeView: string;
  definition: BaseDetailResponse | undefined;
  capability: BaseMemberCapability | undefined;
  embedFilter: BaseFilter | undefined;
  refetchView(): Promise<{ output: QueryOutput | undefined }>;
  refetchDefinition(): Promise<unknown>;
  /** Notice/error are wiped when this changes, e.g. on a view or slug change. */
  resetKey: string;
}

export interface RowActionsModel {
  openInNewTab(path: string): void;
  copyWikilink(row: QueryRow): void;
  copyValue(value: CellValue): void;
  duplicate(row: QueryRow): Promise<void>;
  archive(row: QueryRow): Promise<void>;
  notice: string | undefined;
  error: string | undefined;
}

/** Row-scoped actions for a Base table: open, copy, duplicate, archive. */
export function useRowActions(options: RowActionsOptions): RowActionsModel {
  const {
    slug,
    activeView,
    definition,
    capability,
    embedFilter,
    refetchView,
    refetchDefinition,
    resetKey,
  } = options;
  const openTab = useOpenTab();
  const { copy } = useCopyToClipboard();
  const archivePage = useArchivePage();
  const { mutateAsync: createMember } = useCreateBaseMember();
  const [stored, setStored] = useState<{
    key: string;
    notice: string | undefined;
    error: string | undefined;
  }>({ key: resetKey, notice: undefined, error: undefined });
  const notice = stored.key === resetKey ? stored.notice : undefined;
  const error = stored.key === resetKey ? stored.error : undefined;
  const setResult = useCallback(
    (next: { notice?: string; error?: string }) =>
      setStored({ key: resetKey, notice: next.notice, error: next.error }),
    [resetKey],
  );

  const openInNewTab = useCallback(
    (path: string) => openTab("page", path, undefined, { mode: "new" }),
    [openTab],
  );
  const copyWikilink = useCallback(
    (row: QueryRow) => {
      void copy(wikilinkFor(row));
    },
    [copy],
  );
  const copyValue = useCallback(
    (value: CellValue) => {
      void copy(formatCellValue(value));
    },
    [copy],
  );

  const duplicate = useCallback(
    async (row: QueryRow) => {
      setResult({});
      if (!definition) return;
      try {
        const [propertiesResult, pageResult] = await Promise.all([
          fetchClient.GET("/api/vault/pages/by-id/{uuid}/properties", {
            params: { path: { uuid: row.id } },
          }),
          fetchClient.GET("/api/vault/pages/{path}", {
            params: { path: { path: row.path } },
          }),
        ]);
        if (propertiesResult.error) throw propertiesResult.error;
        if (pageResult.error) throw pageResult.error;
        const title = `${row.title ?? pathStem(row.path)} (copy)`;
        const created = await createMember({
          params: { path: { slug } },
          body: {
            base_revision: definition.revision,
            view: activeView,
            title,
            fields: duplicateFields(
              capability,
              propertiesResult.data?.properties ?? [],
              row,
              pageResult.data?.meta.tags,
            ),
            ...(embedFilter === undefined ? {} : { embed_filter: embedFilter }),
          },
        });
        const refreshed = await refetchView();
        const included = refreshed.output
          ? outputContains(refreshed.output, created.id)
          : true;
        setResult({
          notice: included
            ? `Duplicated as “${created.title}”.`
            : `Duplicated as “${created.title}”, but it is not included in the current view.`,
        });
      } catch (failure) {
        if (isApiConflict(failure)) {
          await refetchDefinition();
          setResult({ error: "The base changed elsewhere; try again." });
          return;
        }
        const diagnostics = decodeBaseMemberDiagnostics(failure);
        const base = formatApiError(failure, "Duplicate failed.");
        setResult({
          error:
            diagnostics.length > 0
              ? `${base} — ${diagnostics.map((d) => d.message).join("; ")}`
              : base,
        });
      }
    },
    [
      activeView,
      capability,
      createMember,
      definition,
      embedFilter,
      refetchDefinition,
      refetchView,
      setResult,
      slug,
    ],
  );

  const archive = useCallback(
    async (row: QueryRow) => {
      setResult({});
      try {
        await archivePage.mutateAsync({ params: { path: { path: row.path } } });
      } catch (failure) {
        throw new Error(
          formatApiError(failure, "The page could not be archived."),
        );
      }
      await refetchView();
    },
    [archivePage.mutateAsync, refetchView, setResult],
  );

  return {
    openInNewTab,
    copyWikilink,
    copyValue,
    duplicate,
    archive,
    notice,
    error,
  };
}
