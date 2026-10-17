import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TagManagementButton } from "#/components/codex/TagManagement";

const transport = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const NativeRequest = globalThis.Request;
  class SameOriginRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? new URL(input, "http://localhost")
          : input,
        init,
      );
    }
  }
  vi.stubGlobal("Request", SameOriginRequest);
  vi.stubGlobal("fetch", fetch);
  return { fetch };
});

const plan = {
  source: "old",
  target: "existing",
  fingerprint: "snapshot-1",
  target_exists: true,
  affected_count: 1,
  computed_count: 0,
  pages: [
    { path: "notes/tagged.md", title: "Tagged page", revision: "revision-1" },
  ],
  conflicts: [] as { path: string | null; reason: string }[],
};
let currentPlan = plan;
let applyStatus = 200;
let applied: unknown[] = [];
let appliedSuccessfully = false;

beforeEach(() => {
  currentPlan = { ...plan, conflicts: [] };
  applied = [];
  applyStatus = 200;
  appliedSuccessfully = false;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path.endsWith("/tags"))
      return response([
        ...(!appliedSuccessfully
          ? [{ tag: "old", count: 1, computed_count: 0 }]
          : []),
        {
          tag: "existing",
          count: appliedSuccessfully ? 3 : 2,
          computed_count: 0,
        },
        { tag: "note", count: 4, computed_count: 4 },
      ]);
    if (path.endsWith("/preview")) return response(currentPlan);
    if (path.endsWith("/apply")) {
      applied.push(await request.json());
      if (applyStatus !== 200)
        return response(
          {
            error: "Preview is stale. Preview again; no pages were changed.",
            detail: { preview: currentPlan },
          },
          applyStatus,
        );
      appliedSuccessfully = true;
      return response({ updated_count: 1 });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

function renderManagement() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const caches = [
    ["board"],
    ["get", "/api/vault/pages/{path}"],
    ["get", "/api/vault/index/search"],
    ["post", "/api/vault/bases/{slug}/views/{view}/evaluate"],
  ];
  for (const key of caches) client.setQueryData(key, { cached: true });
  render(
    <QueryClientProvider client={client}>
      <TagManagementButton />
    </QueryClientProvider>,
  );
  return { client, caches };
}

async function previewMerge() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Manage tags" }));
  await user.click(await screen.findByRole("button", { name: "Rename #old" }));
  await user.type(
    screen.getByRole("textbox", { name: "New tag name" }),
    "existing",
  );
  await user.click(screen.getByRole("button", { name: "Preview rename" }));
  await screen.findByText("notes/tagged.md");
  return user;
}

describe("tag management", () => {
  it("lists counts, searches tags and keeps computed tags read-only", async () => {
    renderManagement();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Manage tags" }));
    const computed = await screen.findByRole("button", {
      name: "Rename #note",
    });
    expect(computed).toBeDisabled();
    expect(
      within(screen.getByRole("row", { name: /#note/ })).getByText("4", {
        selector: "td:last-of-type",
      }),
    ).toBeVisible();
    await user.type(
      screen.getByRole("textbox", { name: "Search tags" }),
      "existing",
    );
    expect(
      screen.queryByRole("button", { name: "Rename #old" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Rename #existing" }),
    ).toBeEnabled();
  });

  it("previews without writes, requires explicit merge, then refreshes dependent views", async () => {
    const { client, caches } = renderManagement();
    const user = await previewMerge();
    expect(applied).toEqual([]);
    expect(
      screen.getByText(
        /descendant tags.*computed kind tags.*saved Base.*embed/i,
      ),
    ).toBeVisible();
    const apply = screen.getByRole("button", { name: "Apply rename" });
    expect(apply).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /I understand.*merge/i }),
    );
    await user.click(apply);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Renamed #old to #existing on 1 page",
    );
    expect(applied).toEqual([
      {
        source: "old",
        target: "existing",
        expected_fingerprint: "snapshot-1",
        acknowledge_merge: true,
      },
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Rename #old" }),
      ).not.toBeInTheDocument(),
    );
    for (const key of caches)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("shows preview conflicts and prevents any apply", async () => {
    currentPlan = {
      ...plan,
      conflicts: [
        {
          path: "notes/tagged.md",
          reason: "Target is this page's computed kind tag",
        },
      ],
    };
    renderManagement();
    await previewMerge();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Target is this page's computed kind tag",
    );
    expect(screen.getByRole("button", { name: "Apply rename" })).toBeDisabled();
    expect(applied).toEqual([]);
  });

  it("requires a fresh preview and new merge acknowledgement after stale apply", async () => {
    applyStatus = 409;
    renderManagement();
    const user = await previewMerge();
    await user.click(
      screen.getByRole("checkbox", { name: /I understand.*merge/i }),
    );
    await user.click(screen.getByRole("button", { name: "Apply rename" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preview is stale",
    );
    expect(
      screen.queryByRole("button", { name: "Apply rename" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New tag name" })).toHaveValue(
      "existing",
    );
    await user.click(screen.getByRole("button", { name: "Preview rename" }));
    expect(
      await screen.findByRole("checkbox", { name: /I understand.*merge/i }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Apply rename" })).toBeDisabled();
  });
});
