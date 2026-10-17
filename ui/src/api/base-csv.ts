import type { QueryClient } from "@tanstack/react-query";
import {
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCreateResponse,
  decodeBaseMemberDiagnostics,
  invalidateBaseMutationQueries,
  type SortKey,
} from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError, isApiConflict, isApiError } from "#/api/error";
import type { components } from "#/api/schema";

export type BaseCsvPreviewRequest =
  components["schemas"]["BaseCsvPreviewRequest"];
export type BaseCsvPreviewResponse =
  components["schemas"]["BaseCsvPreviewResponse"];
export type BaseCsvMapping = components["schemas"]["BaseCsvMapping"];

export interface BaseCsvQuery {
  filter?: BaseFilter;
  sort?: SortKey[];
  q?: string;
  search_columns?: string[];
  columns?: string[];
  group_by?: string;
}

export async function exportBaseCsv(
  slug: string,
  view: string,
  query: BaseCsvQuery,
): Promise<Blob> {
  const result = await fetchClient.GET(
    "/api/vault/bases/{slug}/views/{view}/export.csv",
    {
      params: {
        path: { slug, view },
        query: {
          filter:
            query.filter === undefined
              ? undefined
              : JSON.stringify(query.filter),
          sort_keys:
            query.sort === undefined ? undefined : JSON.stringify(query.sort),
          q: query.q,
          search_columns:
            query.search_columns === undefined
              ? undefined
              : JSON.stringify(query.search_columns),
          columns:
            query.columns === undefined
              ? undefined
              : JSON.stringify(query.columns),
        },
      },
      parseAs: "blob",
    },
  );
  if (!result.response.ok)
    throw new Error(
      `CSV export failed (${result.response.status}). Refresh the view and try again.`,
    );
  if (!result.data) throw new Error("The CSV export response was empty.");
  return result.data;
}

export async function previewBaseCsv(
  slug: string,
  view: string,
  body: BaseCsvPreviewRequest,
): Promise<BaseCsvPreviewResponse> {
  const result = await fetchClient.POST(
    "/api/vault/bases/{slug}/views/{view}/import/preview",
    {
      params: { path: { slug, view } },
      body,
    },
  );
  if (result.error) throw result.error;
  if (!result.data) throw new Error("The CSV preview response was empty.");
  return result.data;
}

export async function getBaseCsvDefinition(
  slug: string,
): Promise<BaseDetailResponse> {
  const result = await fetchClient.GET("/api/vault/bases/{slug}", {
    params: { path: { slug } },
  });
  if (result.error) throw result.error;
  if (!result.data) throw new Error("The Base definition response was empty.");
  return result.data;
}

export type BaseCsvRowOutcome =
  | { row: number; status: "created"; page: BaseMemberCreateResponse }
  | { row: number; status: "failed" | "uncertain"; message: string };

interface BaseCsvImportOptions {
  slug: string;
  view: string;
  definition: BaseDetailResponse;
  preview: BaseCsvPreviewResponse;
  approved: boolean;
  embedFilter?: BaseFilter;
  previous?: readonly BaseCsvRowOutcome[];
  onOutcome?: (outcome: BaseCsvRowOutcome) => void;
}

/** Only confirmed failures can be retried. A lost response may conceal a committed page. */
export async function importBaseCsvRows(
  options: BaseCsvImportOptions,
  client: QueryClient,
): Promise<BaseCsvRowOutcome[]> {
  const {
    slug,
    view,
    definition,
    preview,
    approved,
    embedFilter,
    previous = [],
    onOutcome,
  } = options;
  if (
    !approved ||
    !preview.valid ||
    preview.diagnostics.length > 0 ||
    preview.rows.some((row) => row.diagnostics.length > 0)
  ) {
    throw new Error(
      "A valid CSV preview must be explicitly approved before importing.",
    );
  }
  if (definition.revision !== preview.base_revision) {
    throw new Error(
      "The Base changed since this preview. Preview again before importing.",
    );
  }
  const outcomes = new Map(previous.map((outcome) => [outcome.row, outcome]));
  const pending = preview.rows.filter((row) => {
    const outcome = outcomes.get(row.row);
    return outcome === undefined || outcome.status === "failed";
  });
  if (pending.length === 0) return [...outcomes.values()];
  let revision = preview.base_revision;
  try {
    if (preview.declarations.length > 0) {
      const {
        slug: _slug,
        revision: _revision,
        diagnostics: _diagnostics,
        member_creation: _memberCreation,
        ...base
      } = definition;
      const update = await fetchClient.PUT("/api/vault/bases/{slug}", {
        params: { path: { slug } },
        body: {
          expected_revision: revision,
          definition: {
            ...base,
            properties: [...(base.properties ?? []), ...preview.declarations],
          },
          view_origins: (base.views ?? []).map((entry) => ({
            kind: "existing" as const,
            name: entry.name,
          })),
        },
      });
      if (update.error) throw update.error;
      if (!update.data)
        throw new Error(
          "The schema update response was empty. Preview again before importing.",
        );
      revision = update.data.revision;
    }
    let stoppedByConflict = false;
    for (const row of pending) {
      let outcome: BaseCsvRowOutcome;
      if (stoppedByConflict) {
        outcome = {
          row: row.row,
          status: "failed",
          message:
            "Not attempted: the Base changed. Preview again before retrying.",
        };
      } else {
        try {
          const result = await fetchClient.POST(
            "/api/vault/bases/{slug}/members",
            {
              params: { path: { slug } },
              body: {
                base_revision: revision,
                view,
                title: row.title,
                fields: row.fields,
                embed_filter: embedFilter,
              },
            },
          );
          if (result.error) throw result.error;
          if (!result.data) throw new Error("The creation response was empty.");
          outcome = { row: row.row, status: "created", page: result.data };
        } catch (error) {
          stoppedByConflict = isApiConflict(error);
          const uncertain = !isApiError(error) || (error.status ?? 500) >= 500;
          const diagnostics = decodeBaseMemberDiagnostics(error)
            .map(
              (diagnostic) =>
                `${diagnostic.field ? `${diagnostic.field}: ` : ""}${diagnostic.message}`,
            )
            .join("; ");
          outcome = {
            row: row.row,
            status: uncertain ? "uncertain" : "failed",
            message: uncertain
              ? `${formatApiError(error, "The server response was lost.")} Creation may have completed. Check the vault before importing this row separately; it will not be retried automatically.`
              : [
                  formatApiError(error, "This row could not be created."),
                  diagnostics,
                ]
                  .filter(Boolean)
                  .join(" "),
          };
        }
      }
      outcomes.set(row.row, outcome);
      onOutcome?.(outcome);
    }
    return [...outcomes.values()];
  } finally {
    invalidateBaseMutationQueries(client);
  }
}
