import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useFooterContext,
  useFooterContextStore,
  useFooterParts,
} from "#/store/footerContext";

function Publisher({ parts }: { parts: readonly string[] | null }) {
  useFooterContext(parts);
  return null;
}

beforeEach(() => useFooterContextStore.setState({ owner: null, parts: [] }));

describe("footer context", () => {
  it("shows what the mounted publisher sets and clears on unmount", () => {
    const { unmount } = render(
      <Publisher parts={["notes/a.md", "12 words"]} />,
    );
    expect(renderHook(() => useFooterParts()).result.current).toEqual([
      "notes/a.md",
      "12 words",
    ]);
    unmount();
    expect(useFooterContextStore.getState().parts).toEqual([]);
  });

  it("an inactive publisher (null) never overwrites the active one", () => {
    render(
      <>
        <Publisher parts={["notes/active.md"]} />
        <Publisher parts={null} />
      </>,
    );
    expect(useFooterContextStore.getState().parts).toEqual(["notes/active.md"]);
  });

  it("a publisher that goes inactive releases the slot", () => {
    const { rerender } = render(<Publisher parts={["notes/a.md"]} />);
    rerender(<Publisher parts={null} />);
    expect(useFooterContextStore.getState().parts).toEqual([]);
  });

  it("an old owner's unmount does not clear a newer owner", () => {
    const a = render(<Publisher parts={["notes/a.md"]} />);
    render(<Publisher parts={["notes/b.md"]} />);
    a.unmount();
    expect(useFooterContextStore.getState().parts).toEqual(["notes/b.md"]);
  });
});
