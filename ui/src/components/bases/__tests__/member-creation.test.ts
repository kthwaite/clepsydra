import { describe, expect, it, vi } from "vitest";
import type {
  BaseDetailResponse,
  BaseFilter,
  BaseMemberCapability,
  BaseMemberCreateResponse,
  BaseMemberDiagnostic,
  BaseViewEvaluateResponse,
} from "#/api/bases";
import {
  type MemberCreationSource,
  resolveMemberCreationSession,
} from "#/components/bases/member-creation";
import type { BaseMemberDraftValue } from "#/components/bases/member-draft";

function capability(
  overrides: Partial<BaseMemberCapability> = {},
): BaseMemberCapability {
  return {
    view: "Reading",
    enabled: true,
    fields: [],
    blockers: [],
    ...overrides,
  };
}

function definition(
  overrides: Partial<BaseDetailResponse> = {},
): BaseDetailResponse {
  return {
    slug: "books",
    name: "Books",
    revision: "detail-r1",
    properties: [],
    views: [{ name: "Reading", layout: "table" }],
    diagnostics: [],
    member_creation: [capability()],
    ...overrides,
  };
}

function evaluation(
  overrides: Partial<BaseViewEvaluateResponse> = {},
): BaseViewEvaluateResponse {
  return {
    revision: "evaluation-r1",
    member_creation: capability(),
    output: { shape: "flat", rows: [], total: 0 },
    ...overrides,
  };
}

function requiredSession(source?: MemberCreationSource) {
  const session = resolveMemberCreationSession(
    source ?? {
      kind: "definition",
      baseSlug: "books",
      requestedView: "Reading",
      detail: definition(),
    },
  );
  if (!session) throw new Error("Expected a member creation session");
  return session;
}

const createdMember: BaseMemberCreateResponse = {
  id: "page-1",
  path: "books/trim-me.md",
  revision: "page-r1",
  title: "Trim me",
};

const fieldDiagnostic: BaseMemberDiagnostic = {
  scope: "field",
  field: "rating",
  message: "Rating is outside the allowed range.",
};

describe("resolveMemberCreationSession", () => {
  it("resolves a definition session from requested view then first-view fallback", () => {
    const detail = definition({
      revision: "detail-r1",
      views: [{ name: "Reading" }],
      member_creation: [capability({ view: "reading" })],
    });

    expect(
      resolveMemberCreationSession({
        kind: "definition",
        baseSlug: "books",
        requestedView: "",
        detail,
      }),
    ).toMatchObject({ view: "Reading", capability: { view: "reading" } });
  });

  it("gives a requested definition view precedence and folds ASCII case", () => {
    const shelfCapability = capability({ view: "sHeLf" });

    expect(
      resolveMemberCreationSession({
        kind: "definition",
        baseSlug: "books",
        requestedView: "Shelf",
        detail: definition({
          views: [{ name: "Reading" }, { name: "Shelf" }],
          member_creation: [capability(), shelfCapability],
        }),
      }),
    ).toMatchObject({ view: "Shelf", capability: shelfCapability });
  });

  it("returns undefined when a definition has no active view", () => {
    expect(
      resolveMemberCreationSession({
        kind: "definition",
        baseSlug: "books",
        requestedView: "",
        detail: definition({ views: [] }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when a definition has no revision", () => {
    expect(
      resolveMemberCreationSession({
        kind: "definition",
        baseSlug: "books",
        requestedView: "Reading",
        detail: definition({ revision: "" }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when a definition has no matching capability", () => {
    expect(
      resolveMemberCreationSession({
        kind: "definition",
        baseSlug: "books",
        requestedView: "Reading",
        detail: definition({
          member_creation: [capability({ view: "Shelf" })],
        }),
      }),
    ).toBeUndefined();
  });

  it("uses the evaluator-owned capability for an evaluation session", () => {
    const evaluatorCapability = capability({ view: "rEaDiNg", enabled: false });

    expect(
      resolveMemberCreationSession({
        kind: "evaluation",
        baseSlug: "books",
        requestedView: "Reading",
        evaluation: evaluation({
          revision: "evaluator-r9",
          member_creation: evaluatorCapability,
        }),
      }),
    ).toMatchObject({
      view: "Reading",
      capability: evaluatorCapability,
    });
  });

  it("returns undefined when an evaluation has no active view", () => {
    expect(
      resolveMemberCreationSession({
        kind: "evaluation",
        baseSlug: "books",
        requestedView: "",
        evaluation: evaluation(),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when an evaluation has no revision", () => {
    expect(
      resolveMemberCreationSession({
        kind: "evaluation",
        baseSlug: "books",
        requestedView: "Reading",
        evaluation: evaluation({ revision: "" }),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the evaluator capability is for another view", () => {
    expect(
      resolveMemberCreationSession({
        kind: "evaluation",
        baseSlug: "books",
        requestedView: "Reading",
        evaluation: evaluation({
          member_creation: capability({ view: "Shelf" }),
        }),
      }),
    ).toBeUndefined();
  });
});

describe("MemberCreationSession.submit", () => {
  it("creates once with a normalized definition request and returns the response", async () => {
    const create = vi.fn().mockResolvedValue(createdMember);
    const refreshAfterConflict = vi.fn();
    const draft: BaseMemberDraftValue = {
      title: "  Trim me  ",
      fields: {
        tags: [],
        subtitle: "",
        featured: false,
        rating: 0,
        omittedNull: null,
        omittedUndefined: undefined,
      } as unknown as BaseMemberDraftValue["fields"],
    };

    await expect(
      requiredSession().submit(draft, { create, refreshAfterConflict }),
    ).resolves.toEqual({ kind: "created", member: createdMember });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith("books", {
      base_revision: "detail-r1",
      view: "Reading",
      title: "Trim me",
      fields: {
        tags: [],
        subtitle: "",
        featured: false,
        rating: 0,
      },
    });
    expect(refreshAfterConflict).not.toHaveBeenCalled();
  });

  it("uses the evaluator revision and captures the embedded filter", async () => {
    const create = vi.fn().mockResolvedValue(createdMember);
    const embedFilter: BaseFilter = {
      field: "status",
      op: "eq",
      value: "reading",
    };
    const session = requiredSession({
      kind: "evaluation",
      baseSlug: "books",
      requestedView: "Reading",
      evaluation: evaluation({ revision: "evaluator-r9" }),
      embedFilter,
    });

    await session.submit(
      { title: "New book", fields: { status: "reading" } },
      { create, refreshAfterConflict: vi.fn() },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith("books", {
      base_revision: "evaluator-r9",
      view: "Reading",
      title: "New book",
      fields: { status: "reading" },
      embed_filter: embedFilter,
    });
  });

  it.each(["base_revision_conflict", "revision_conflict"])(
    "refreshes once for recognized 409 code %s and returns conflict",
    async (code) => {
      const failure = {
        status: 409,
        error: "The Base changed.",
        detail: { code, diagnostics: [fieldDiagnostic] },
      };
      const create = vi.fn().mockRejectedValue(failure);
      const refreshAfterConflict = vi.fn().mockResolvedValue(undefined);

      await expect(
        requiredSession().submit(
          { title: "New book", fields: {} },
          { create, refreshAfterConflict },
        ),
      ).resolves.toEqual({
        kind: "conflict",
        message: "The Base changed.",
        diagnostics: [fieldDiagnostic],
      });
      expect(create).toHaveBeenCalledOnce();
      expect(refreshAfterConflict).toHaveBeenCalledOnce();
    },
  );

  it("does not refresh an ordinary 409", async () => {
    const failure = {
      status: 409,
      error: "A page already exists.",
      detail: { code: "page_conflict", diagnostics: [fieldDiagnostic] },
    };
    const refreshAfterConflict = vi.fn();

    await expect(
      requiredSession().submit(
        { title: "New book", fields: {} },
        { create: vi.fn().mockRejectedValue(failure), refreshAfterConflict },
      ),
    ).resolves.toEqual({
      kind: "failed",
      message: "A page already exists.",
      diagnostics: [fieldDiagnostic],
    });
    expect(refreshAfterConflict).not.toHaveBeenCalled();
  });

  it("returns a failed outcome when conflict refresh rejects", async () => {
    const failure = {
      status: 409,
      error: "The Base changed.",
      detail: {
        code: "base_revision_conflict",
        diagnostics: [fieldDiagnostic],
      },
    };
    const refreshAfterConflict = vi
      .fn()
      .mockRejectedValue(new Error("Definition refresh failed."));

    await expect(
      requiredSession().submit(
        { title: "New book", fields: {} },
        { create: vi.fn().mockRejectedValue(failure), refreshAfterConflict },
      ),
    ).resolves.toEqual({
      kind: "failed",
      message: "Definition refresh failed.",
      diagnostics: [fieldDiagnostic],
    });
    expect(refreshAfterConflict).toHaveBeenCalledOnce();
  });

  it("uses the refresh fallback message for an unrecognized refresh error", async () => {
    const failure = {
      status: 409,
      error: "The Base changed.",
      detail: { code: "revision_conflict" },
    };

    await expect(
      requiredSession().submit(
        { title: "New book", fields: {} },
        {
          create: vi.fn().mockRejectedValue(failure),
          refreshAfterConflict: vi.fn().mockRejectedValue(null),
        },
      ),
    ).resolves.toEqual({
      kind: "failed",
      message: "Base definition could not be refreshed.",
      diagnostics: [],
    });
  });

  it("returns an ordinary API failure with valid diagnostics", async () => {
    const failure = {
      status: 422,
      error: "Candidate rejected.",
      detail: { diagnostics: [fieldDiagnostic] },
    };

    await expect(
      requiredSession().submit(
        { title: "New book", fields: {} },
        {
          create: vi.fn().mockRejectedValue(failure),
          refreshAfterConflict: vi.fn(),
        },
      ),
    ).resolves.toEqual({
      kind: "failed",
      message: "Candidate rejected.",
      diagnostics: [fieldDiagnostic],
    });
  });

  it("falls back and discards malformed diagnostics", async () => {
    const failure = {
      status: 500,
      error: "",
      detail: { diagnostics: [fieldDiagnostic, { scope: "field" }] },
    };

    await expect(
      requiredSession().submit(
        { title: "New book", fields: {} },
        {
          create: vi.fn().mockRejectedValue(failure),
          refreshAfterConflict: vi.fn(),
        },
      ),
    ).resolves.toEqual({
      kind: "failed",
      message: "Member could not be created.",
      diagnostics: [],
    });
  });
});
