import {
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCapability,
  type BaseMemberCreateRequest,
  type BaseMemberCreateResponse,
  type BaseMemberDiagnostic,
  type BaseViewEvaluateResponse,
  decodeBaseMemberDiagnostics,
} from "#/api/bases";
import { formatApiError, isApiError } from "#/api/error";
import { asciiCaseFold } from "./local-validation";
import type { BaseMemberDraftValue } from "./member-draft";

export type MemberCreationSource =
  | {
      kind: "definition";
      baseSlug: string;
      requestedView: string;
      detail: BaseDetailResponse;
    }
  | {
      kind: "evaluation";
      baseSlug: string;
      requestedView: string;
      evaluation: BaseViewEvaluateResponse;
      embedFilter?: BaseFilter;
    };

export interface MemberCreationDependencies {
  create(
    baseSlug: string,
    request: BaseMemberCreateRequest,
  ): Promise<BaseMemberCreateResponse>;
  refreshAfterConflict(): Promise<void>;
}

export type MemberCreationOutcome =
  | { kind: "created"; member: BaseMemberCreateResponse }
  | {
      kind: "conflict";
      message: string;
      diagnostics: BaseMemberDiagnostic[];
    }
  | { kind: "failed"; message: string; diagnostics: BaseMemberDiagnostic[] };

export interface MemberCreationSession {
  view: string;
  capability: BaseMemberCapability;
  submit(
    draft: BaseMemberDraftValue,
    dependencies: MemberCreationDependencies,
  ): Promise<MemberCreationOutcome>;
}

interface ResolvedSource {
  baseSlug: string;
  view: string;
  revision: string;
  capability: BaseMemberCapability;
  evaluation: boolean;
  embedFilter?: BaseFilter;
}

function isRevisionConflict(error: unknown): boolean {
  if (
    !isApiError(error) ||
    error.status !== 409 ||
    typeof error.detail !== "object" ||
    error.detail === null ||
    !("code" in error.detail)
  ) {
    return false;
  }
  return (
    error.detail.code === "base_revision_conflict" ||
    error.detail.code === "revision_conflict"
  );
}

function createSession(source: ResolvedSource): MemberCreationSession {
  return {
    view: source.view,
    capability: source.capability,
    async submit(draft, dependencies) {
      const fields: BaseMemberDraftValue["fields"] = {};
      for (const key in draft.fields) {
        if (!Object.hasOwn(draft.fields, key)) continue;
        const value = draft.fields[key];
        if (value !== null && value !== undefined) fields[key] = value;
      }

      const request: BaseMemberCreateRequest = {
        base_revision: source.revision,
        view: source.view,
        title: draft.title.trim(),
        fields,
      };
      if (source.evaluation) request.embed_filter = source.embedFilter;

      try {
        const member = await dependencies.create(source.baseSlug, request);
        return { kind: "created", member };
      } catch (error) {
        const diagnostics = decodeBaseMemberDiagnostics(error);
        const message = formatApiError(error, "Member could not be created.");
        if (!isRevisionConflict(error)) {
          return { kind: "failed", message, diagnostics };
        }

        try {
          await dependencies.refreshAfterConflict();
        } catch (refreshError) {
          return {
            kind: "failed",
            message: formatApiError(
              refreshError,
              "Base definition could not be refreshed.",
            ),
            diagnostics,
          };
        }
        return { kind: "conflict", message, diagnostics };
      }
    },
  };
}

export function resolveMemberCreationSession(
  source: MemberCreationSource,
): MemberCreationSession | undefined {
  const view =
    source.kind === "definition"
      ? source.requestedView || source.detail.views?.[0]?.name || ""
      : source.requestedView;
  const revision =
    source.kind === "definition"
      ? source.detail.revision
      : source.evaluation.revision;
  if (!view || !revision) return undefined;

  const foldedView = asciiCaseFold(view);
  const capability =
    source.kind === "definition"
      ? source.detail.member_creation.find(
          (candidate) => asciiCaseFold(candidate.view) === foldedView,
        )
      : source.evaluation.member_creation;
  if (!capability || asciiCaseFold(capability.view) !== foldedView) {
    return undefined;
  }

  const resolved: ResolvedSource = {
    baseSlug: source.baseSlug,
    view,
    revision,
    capability,
    evaluation: source.kind === "evaluation",
  };
  if (source.kind === "evaluation") resolved.embedFilter = source.embedFilter;
  return createSession(resolved);
}
