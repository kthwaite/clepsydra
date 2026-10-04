/**
 * TaskCard description: the page body rendered as compact markdown, with
 * wikilinks opening pages through onOpenPage instead of the card editor.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BoardTask } from "#/api/board";
import { TaskCard } from "../TaskCard";
import { BOARD_FIXTURE, FIXTURE_COL_LABEL } from "./fixtures";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  draggable: () => () => {},
  dropTargetForElements: () => () => {},
}));

vi.mock("#/editor/useResolveWikilinkTarget", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useResolveWikilinkTarget: () => ({ resolve: resolveMock }),
}));

const BASE: BoardTask = { ...BOARD_FIXTURE.tasks[0], body_excerpt: null };

function renderCard(
  task: Partial<BoardTask>,
  props: { onClick?: () => void; onOpenPage?: (path: string) => void } = {},
) {
  const t = { ...BASE, ...task };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TaskCard
        task={t}
        showOp={false}
        onClick={props.onClick ?? vi.fn()}
        onOpenPage={props.onOpenPage}
        colLabel={FIXTURE_COL_LABEL}
        taskByCode={new Map([[t.code, t]])}
      />
    </QueryClientProvider>,
  );
  return t;
}

describe("TaskCard — description", () => {
  it("renders the description as markdown", () => {
    const t = renderCard({ description: "Ship **the thing** soon." });
    const body = screen.getByTestId(`task-excerpt-${t.id}`);
    expect(within(body).getByText("the thing").tagName).toBe("STRONG");
  });

  it("renders headings at body size and hides images", () => {
    const t = renderCard({
      description: "# Big heading\n\n![diagram](diagram.png)\n\nAfter.",
    });
    const body = screen.getByTestId(`task-excerpt-${t.id}`);
    expect(within(body).queryByRole("heading")).toBeNull();
    expect(within(body).getByText("Big heading")).toBeInTheDocument();
    expect(within(body).queryByRole("img")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
  });

  it("opens a wikilink through onOpenPage, not the card editor", async () => {
    resolveMock.mockResolvedValue({
      path: "notes/design-note.md",
      title: "Design Note",
    });
    const onClick = vi.fn();
    const onOpenPage = vi.fn();
    const t = renderCard(
      { description: "Per [[Design Note]]." },
      { onClick, onOpenPage },
    );
    const body = screen.getByTestId(`task-excerpt-${t.id}`);
    await userEvent.click(within(body).getByText("Design Note"));
    await waitFor(() =>
      expect(onOpenPage).toHaveBeenCalledWith("notes/design-note.md"),
    );
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders nothing when description and excerpt are empty", () => {
    const t = renderCard({ description: null, body_excerpt: "" });
    expect(screen.queryByTestId(`task-excerpt-${t.id}`)).toBeNull();
  });

  it("falls back to the plain excerpt when there is no description", () => {
    const t = renderCard({ body_excerpt: "Plain projected text." });
    expect(screen.getByTestId(`task-excerpt-${t.id}`)).toHaveTextContent(
      "Plain projected text.",
    );
  });
});
