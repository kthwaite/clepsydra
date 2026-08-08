import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RenderElementProps } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";

type CapturedCLinkProps = {
  path?: string;
  onClick?: (e: unknown) => void;
  className?: string;
  children?: ReactNode;
};

const { lookupMock, openTabMock, resolveOrCreateMock, clinkCalls } = vi.hoisted(
  () => ({
    lookupMock: vi.fn(),
    openTabMock: vi.fn(),
    resolveOrCreateMock: vi.fn(),
    clinkCalls: [] as Array<{
      path?: string;
      onClick?: (e: unknown) => void;
      className?: string;
      children?: unknown;
    }>,
  }),
);

vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({ lookup: lookupMock }),
}));
vi.mock("#/editor/useResolveOrCreateWikilinkTarget", () => ({
  useResolveOrCreateWikilinkTarget: () => ({
    resolveOrCreate: resolveOrCreateMock,
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/components/codex/CLink", () => ({
  CLink: (props: CapturedCLinkProps) => {
    clinkCalls.push(props);
    return (
      <span
        role="link"
        tabIndex={0}
        className={props.className}
        onClick={props.onClick}
        onKeyDown={() => {}}
      >
        {props.children}
      </span>
    );
  },
}));

import { WikilinkElement } from "#/editor/elements/WikilinkElement";

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  "data-slate-void": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

function renderWikilink(target: string, alias?: string) {
  const element: WikilinkElementType = {
    type: "wikilink",
    target,
    alias,
    children: [{ text: "" }],
  };
  return render(
    <WikilinkElement attributes={attributes} element={element}>
      {null}
    </WikilinkElement>,
  );
}

function lastCLink() {
  const props = clinkCalls[clinkCalls.length - 1];
  expect(props).toBeDefined();
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  clinkCalls.length = 0;
  lookupMock.mockReturnValue(null);
  resolveOrCreateMock.mockResolvedValue({
    path: "notes/new-topic.md",
    title: "New Topic",
  });
});

describe("WikilinkElement resolved", () => {
  it("passes the resolved vault path to CLink, not the raw target", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes");

    expect(lookupMock).toHaveBeenCalledWith("Clepsydra Design Notes");
    const clink = lastCLink();
    expect(clink.path).toBe("notes/clepsydra-design.md");
    expect(clink.onClick).toBeUndefined();
  });

  it("keeps the standard styling without dangling classes", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes");

    const link = screen.getByRole("link");
    expect(link.className).not.toContain("decoration-dashed");
    expect(link.className).not.toContain("text-ink-mute");
    expect(link.className).toContain("text-ink");
  });

  it("shows the alias alongside the target", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes", "the design doc");

    expect(screen.getByText("Clepsydra Design Notes")).toBeDefined();
    expect(screen.getByText("the design doc")).toBeDefined();
  });
});

describe("WikilinkElement dangling", () => {
  it("renders muted dashed styling and passes no path to CLink", () => {
    renderWikilink("Unwritten Page");

    const clink = lastCLink();
    expect(clink.path).toBeUndefined();
    expect(typeof clink.onClick).toBe("function");

    const link = screen.getByRole("link");
    expect(link.className).toContain("text-ink-mute");
    expect(link.className).toContain("decoration-dashed");
  });

  it("shows the alias alongside the target", () => {
    renderWikilink("Unwritten Page", "someday");

    expect(screen.getByText("Unwritten Page")).toBeDefined();
    expect(screen.getByText("someday")).toBeDefined();
  });
});

describe("WikilinkElement dangling click", () => {
  it("opens the path returned by the shared resolver", async () => {
    const user = userEvent.setup();
    resolveOrCreateMock.mockResolvedValue({
      path: "notes/new-topic.md",
      title: "New Topic",
    });
    renderWikilink("New Topic");

    await user.click(screen.getByRole("link"));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
    );
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
  });

  it("leaves the link dangling when resolution or creation fails", async () => {
    const user = userEvent.setup();
    resolveOrCreateMock.mockRejectedValue(new Error("create failed"));
    renderWikilink("New Topic");

    await user.click(screen.getByRole("link"));

    await waitFor(() =>
      expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic"),
    );
    expect(openTabMock).not.toHaveBeenCalled();
  });
});
