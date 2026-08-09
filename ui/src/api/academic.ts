import { useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { $api } from "./client";
import { invalidateByPath, invalidatePageStructure, queryKeys } from "./keys";

export type AnnotationDetail = components["schemas"]["AnnotationDetail"];
export type AnnotationType = components["schemas"]["AnnotationType"];
export type ConflictPolicy = components["schemas"]["ConflictPolicy"];
export type CreateAnnotationRequest =
  components["schemas"]["CreateAnnotationRequest"];
export type CreateWorkRequest = components["schemas"]["CreateWorkRequest"];
export type ImportResponse = components["schemas"]["ImportResponse"];
export type ImportResult = components["schemas"]["ImportResult"];
export type ImportZoteroRequest = components["schemas"]["ImportZoteroRequest"];
export type ReadingStatus = components["schemas"]["ReadingStatus"];
export type UpdateWorkRequest = components["schemas"]["UpdateWorkRequest"];
export type WorkDetail = components["schemas"]["WorkDetail"];
export type WorkSummary = components["schemas"]["WorkSummary"];
export type WorkSummaryListResponse =
  components["schemas"]["WorkSummaryListResponse"];
export type WorkType = components["schemas"]["WorkType"];

export interface WorkFilters {
  work_type?: string;
  status?: string;
  year?: number;
  author?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

function useAcademicInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    invalidateByPath(queryClient, queryKeys.academic.pathPrefix);
    invalidatePageStructure(queryClient);
  };
}

export function useWorks(filters: WorkFilters = {}) {
  return $api.useQuery("get", "/api/vault/academic/works", {
    params: { query: filters },
  });
}

export function useWork(workId: string) {
  return $api.useQuery(
    "get",
    "/api/vault/academic/works/by-id/{uuid}",
    { params: { path: { uuid: workId } } },
    { enabled: !!workId },
  );
}

export function useAnnotations(workId: string) {
  return $api.useQuery(
    "get",
    "/api/vault/academic/works/by-id/{uuid}/annotations",
    { params: { path: { uuid: workId } } },
    { enabled: !!workId },
  );
}

export function useCreateWork() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/works", {
    onSuccess: invalidate,
  });
}

export function useUpdateWork() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("put", "/api/vault/academic/works/by-id/{uuid}", {
    onSuccess: invalidate,
  });
}

export function useCreateAnnotation() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/annotations", {
    onSuccess: invalidate,
  });
}

export function useImportBibtex() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/import/bibtex", {
    onSuccess: invalidate,
  });
}

export function useImportDoi() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/import/doi", {
    onSuccess: invalidate,
  });
}

export function useImportIsbn() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/import/isbn", {
    onSuccess: invalidate,
  });
}

export function useImportZotero() {
  const invalidate = useAcademicInvalidation();
  return $api.useMutation("post", "/api/vault/academic/import/zotero", {
    onSuccess: invalidate,
  });
}
