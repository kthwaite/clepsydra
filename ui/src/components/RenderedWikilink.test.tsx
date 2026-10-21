import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreviewContext,
  PreviewRestrictionsContext,
} from "#/components/codex/PreviewContext";
import { RenderedWikilink } from "#/components/RenderedWikilink";
import type * as ResolverExports from "#/editor/useResolveWikilinkTarget";
import { usePreviewStore } from "#/store/preview";

const { lookup, resolve, error } = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolve: vi.fn(),
  error: vi.fn(),
}));
vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({ lookup }),
}));
vi.mock("#/editor/useResolveWikilinkTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof ResolverExports>()),
  useResolveWikilinkTarget: () => ({ resolve }),
}));
vi.mock("sonner", () => ({ toast: { error } }));

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockReturnValue("notes/person.md");
  resolve.mockResolvedValue(null);
  usePreviewStore.setState({ windows: [], topZ: 200 });
});

describe("rendered wikilink previews", () => {
  it("carries the heading through ordinary navigation and native modifier navigation", () => {
    const onOpen = vi.fn();
    render(
      <RenderedWikilink target="Person#Biography" onOpen={onOpen}>
        Person
      </RenderedWikilink>,
    );
    const link = screen.getByRole("link", { name: "Person" });
    expect(link.getAttribute("href")).toContain("#Biography");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("notes/person.md", "Person", {
      heading: "Biography",
    });
    onOpen.mockClear();
    fireEvent.click(link, { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a restricted child reader from normal activation inside a preview", () => {
    const onOpen = vi.fn();
    const parent = usePreviewStore
      .getState()
      .open({ path: "notes/parent.md" }, new DOMRect(), { mode: "reader" });
    render(
      <PreviewContext value={parent}>
        <PreviewRestrictionsContext value={true}>
          <RenderedWikilink target="Person#Biography" onOpen={onOpen}>
            Person
          </RenderedWikilink>
        </PreviewRestrictionsContext>
      </PreviewContext>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Person" }));
    expect(usePreviewStore.getState().windows).toContainEqual(
      expect.objectContaining({
        path: "notes/person.md",
        heading: "Biography",
        parentId: parent,
        mode: "reader",
        restricted: true,
      }),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reports a missing target on keyboard activation without navigating", async () => {
    lookup.mockReturnValue(null);
    const onOpen = vi.fn();
    render(
      <RenderedWikilink target="Missing" onOpen={onOpen}>
        Missing
      </RenderedWikilink>,
    );
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("link", { name: "Missing" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("No page named “Missing”"),
    );
    expect(usePreviewStore.getState().windows).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
