import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Middleware } from "openapi-fetch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import type { components, paths } from "#/api/schema";
import { useBoardStore } from "#/store/board";
import { TaskingScreen } from "../TaskingScreen";
import { BOARD_FIXTURE } from "./fixtures";

vi.mock("#/api/client", async () => {
  // Vitest hoists this factory before static imports are initialized.
  const { default: createFetchClient } = await import("openapi-fetch");
  const { default: createClient } = await import("openapi-react-query");
  const fetchClient = createFetchClient<paths>({ baseUrl: "http://localhost" });
  return { fetchClient, $api: createClient(fetchClient) };
});

type ProjectPage = components["schemas"]["PageSummary"] & { board: boolean };

const httpBoundary: Middleware = {
  onRequest: ({ request }) => fetch(request),
};

function projectServer({ failSecond = false, hidden = false } = {}) {
  const pages: ProjectPage[] = [
    {
      id: "alpha-one",
      path: "projects/alpha.md",
      title: "Alpha",
      canonical_name: "Alpha",
      kind: "PROJECT",
      project: "alpha",
      tags: [],
      aliases: [],
      computed_tags: [],
      encrypted: false,
      inferred: false,
      board: !hidden,
    },
    {
      id: "alpha-two",
      path: "projects/alpha-notes.md",
      title: "Alpha notes",
      canonical_name: "Alpha notes",
      kind: "PROJECT",
      project: "alpha",
      tags: [],
      aliases: [],
      computed_tags: [],
      encrypted: false,
      inferred: false,
      board: !hidden,
    },
  ];
  const patches: Array<{
    id: string;
    body: components["schemas"]["PropertyPatchRequest"];
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input
          : new Request(new URL(String(input), "http://localhost"), init);
      const url = new URL(request.url);
      if (url.pathname === "/api/vault/pages") {
        return Response.json({ items: pages, total: pages.length, offset: 0 });
      }
      if (url.pathname === "/api/vault/board") {
        const listed = pages.some((page) => page.board);
        return Response.json({
          ...BOARD_FIXTURE,
          operations: BOARD_FIXTURE.operations.filter(
            (op) => op.project !== "alpha" || listed,
          ),
          tasks: BOARD_FIXTURE.tasks.filter(
            (task) =>
              task.project !== "alpha" ||
              listed ||
              url.searchParams.has("include_retired"),
          ),
        });
      }
      if (request.method === "PATCH") {
        const page = pages.find(
          (candidate) =>
            url.pathname ===
            `/api/vault/pages/by-id/${candidate.id}/properties`,
        );
        if (!page) throw new Error(`Unexpected patch: ${url}`);
        const body: components["schemas"]["PropertyPatchRequest"] =
          await request.json();
        patches.push({ id: page.id, body });
        if (failSecond && page.id === "alpha-two") {
          return Response.json(
            { error: "Page changed; refresh before editing" },
            { status: 409 },
          );
        }
        page.board = body.set?.board === true;
        return Response.json({
          id: page.id,
          path: page.path,
          revision: "saved",
          properties: { board: page.board },
        });
      }
      const page = pages.find(
        (candidate) =>
          decodeURIComponent(url.pathname) ===
          `/api/vault/pages/${candidate.path}`,
      );
      if (page) {
        return Response.json({
          path: page.path,
          meta: { id: page.id, title: page.title },
          revision: `revision-${page.id}`,
          body: "Unchanged project notes",
          kind: "PROJECT",
          project: "alpha",
          encrypted: false,
          readonly: false,
        });
      }
      if (url.pathname === "/api/vault/tasks/history")
        return Response.json({ days: [] });
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }),
  );
  return {
    patches,
    allowSecond: () => {
      failSecond = false;
    },
  };
}

function renderBoard(onOpenPage = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskingScreen onOpenPage={onOpenPage} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchClient.use(httpBoundary);
  useBoardStore.setState({
    mode: "card",
    opFilter: "ALL",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
});
afterEach(() => {
  fetchClient.eject(httpBoundary);
  vi.unstubAllGlobals();
});

it("hides every Project page sharing a slug and restores it after reopening the board", async () => {
  const { patches } = projectServer();
  const view = renderBoard();
  await userEvent.click(
    await screen.findByRole("button", { name: "Manage projects" }),
  );
  let dialog = await screen.findByRole("dialog", {
    name: "Manage board projects",
  });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Hide alpha" }),
  );
  await within(dialog).findByRole("button", { name: "Restore alpha" });
  expect(patches).toEqual([
    {
      id: "alpha-one",
      body: {
        set: { board: false },
        clear: [],
        types: { board: "bool" },
        expected_revision: "revision-alpha-one",
      },
    },
    {
      id: "alpha-two",
      body: {
        set: { board: false },
        clear: [],
        types: { board: "bool" },
        expected_revision: "revision-alpha-two",
      },
    },
  ]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Task Alpha 1")).not.toBeInTheDocument();
  expect(screen.getByText("Task Beta 1")).toBeInTheDocument();
  view.unmount();
  renderBoard();
  await userEvent.click(
    await screen.findByRole("button", { name: "Manage projects" }),
  );
  dialog = await screen.findByRole("dialog", { name: "Manage board projects" });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Restore alpha" }),
  );
  await within(dialog).findByRole("button", { name: "Hide alpha" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(await screen.findByText("Task Alpha 1")).toBeInTheDocument();
  expect(patches.slice(2).map(({ body }) => body.set)).toEqual([
    { board: true },
    { board: true },
  ]);
});

it("keeps hidden Project notes directly openable", async () => {
  projectServer({ hidden: true });
  const open = vi.fn();
  renderBoard(open);
  await userEvent.click(
    await screen.findByRole("button", { name: "Manage projects" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage board projects",
  });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Open Alpha notes" }),
  );
  expect(open).toHaveBeenCalledWith("projects/alpha-notes.md", "Alpha notes");
});

it("reports partial failure with its failed page and leaves the still-active project visible", async () => {
  const server = projectServer({ failSecond: true });
  renderBoard();
  await userEvent.click(
    await screen.findByRole("button", { name: "Manage projects" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage board projects",
  });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Hide alpha" }),
  );
  const error = await within(dialog).findByRole("alert");
  expect(error).toHaveTextContent("1 of 2");
  expect(error).toHaveTextContent("Alpha notes");
  expect(error).toHaveTextContent("Page changed");
  expect(
    within(dialog).getByRole("button", { name: "Hide alpha" }),
  ).toBeEnabled();
  server.allowSecond();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Hide alpha" }),
  );
  await waitFor(() =>
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument(),
  );
  await within(dialog).findByRole("button", { name: "Restore alpha" });
});

it("can finish a partially restored slug even after its first page returns to the board", async () => {
  const server = projectServer({ failSecond: true, hidden: true });
  renderBoard();
  await userEvent.click(
    await screen.findByRole("button", { name: "Manage projects" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage board projects",
  });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "Restore alpha" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("1 of 2");
  server.allowSecond();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Retry incomplete change" }),
  );
  await waitFor(() =>
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(server.patches.slice(2).map(({ body }) => body.set)).toEqual([
      { board: true },
      { board: true },
    ]),
  );
});
