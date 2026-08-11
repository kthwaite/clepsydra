import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useScrollSpy } from "#/components/codex/useScrollSpy";

// jsdom computes no layout, so geometry is stubbed at the prototype level:
// the container reports a fixed viewport (clientHeight 600, scrollHeight
// 2600 → maxScroll 2000) and each heading derives its viewport-relative rect
// from a data-offset attribute minus the container's scrollTop.
const CLIENT_HEIGHT = 600;
const SCROLL_HEIGHT = 2600;
const MAX_SCROLL = SCROLL_HEIGHT - CLIENT_HEIGHT;
// last four headings cluster near the document end: their natural trigger
// positions (offset - 96) lie beyond maxScroll
const HEADING_OFFSETS = [100, 600, 2450, 2500, 2540, 2560];

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const proto = HTMLElement.prototype as HTMLElement & {
  scrollTo: (opts: ScrollToOptions) => void;
};
const origGetRect = proto.getBoundingClientRect;
const origScrollTo = proto.scrollTo;

beforeEach(() => {
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.scrollContainer !== undefined) return rect(0);
    if (this.dataset.offset !== undefined) {
      const container = this.closest<HTMLElement>("[data-scroll-container]");
      return rect(Number(this.dataset.offset) - (container?.scrollTop ?? 0));
    }
    return origGetRect.call(this);
  };
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.scrollContainer !== undefined ? SCROLL_HEIGHT : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.scrollContainer !== undefined ? CLIENT_HEIGHT : 0;
    },
  });
  proto.scrollTo = function (this: HTMLElement, opts: ScrollToOptions) {
    // browsers clamp to the scrollable range
    this.scrollTop = Math.max(0, Math.min(opts.top ?? 0, MAX_SCROLL));
    fireEvent.scroll(this);
  };
});

afterEach(() => {
  proto.getBoundingClientRect = origGetRect;
  proto.scrollTo = origScrollTo;
  // restore jsdom's prototype getters by removing our overrides
  delete (proto as unknown as Record<string, unknown>).scrollHeight;
  delete (proto as unknown as Record<string, unknown>).clientHeight;
});

let api: ReturnType<typeof useScrollSpy>;

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  api = useScrollSpy(ref, 0);
  return (
    <div ref={ref} data-scroll-container data-testid="container">
      <output data-testid="active">{api.activeIndex}</output>
      <div data-slate-editor>
        {HEADING_OFFSETS.map((offset, i) => (
          <h2 key={offset} data-offset={offset}>
            Heading {i}
          </h2>
        ))}
      </div>
    </div>
  );
}

function JournalFolioHarness() {
  const ref = useRef<HTMLDivElement>(null);
  api = useScrollSpy(ref, 0);
  return (
    <>
      <nav aria-label="Contents">
        <button type="button" onClick={() => api.scrollTo(0)}>
          09:07
        </button>
        <button type="button" onClick={() => api.scrollTo(1)}>
          Ordinary section
        </button>
      </nav>
      <div ref={ref} data-scroll-container data-testid="journal-container">
        <output data-testid="journal-active">{api.activeIndex}</output>
        <h1 data-offset={100}>Tuesday, August 11</h1>
        <div data-slate-editor>
          <h2 data-offset={600}>09:07</h2>
          <h3 data-offset={1200}>Ordinary section</h3>
        </div>
      </div>
      <nav aria-label="Reading position">
        <button
          type="button"
          aria-label="1 09:07"
          onClick={() => api.scrollTo(0)}
        />
        <button
          type="button"
          aria-label="1.1 Ordinary section"
          onClick={() => api.scrollTo(1)}
        />
      </nav>
    </>
  );
}

describe("useScrollSpy", () => {
  it("activates the last heading when scrolled to the bottom", () => {
    render(<Harness />);
    const container = screen.getByTestId("container");
    container.scrollTop = MAX_SCROLL;
    fireEvent.scroll(container);
    expect(screen.getByTestId("active")).toHaveTextContent("5");
  });

  it("activates each bottom-clustered heading at some scroll position", () => {
    render(<Harness />);
    const container = screen.getByTestId("container");
    const seen = new Set<number>();
    for (let top = 0; top <= MAX_SCROLL; top += 1) {
      container.scrollTop = top;
      fireEvent.scroll(container);
      seen.add(api.activeIndex);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("highlights the clicked heading after jumping to a clustered entry", () => {
    render(<Harness />);
    act(() => api.scrollTo(3));
    expect(screen.getByTestId("active")).toHaveTextContent("3");
  });

  it("still jumps ordinary headings to just above the threshold line", () => {
    render(<Harness />);
    const container = screen.getByTestId("container");
    act(() => api.scrollTo(1));
    expect(container.scrollTop).toBe(HEADING_OFFSETS[1] - 16);
    expect(screen.getByTestId("active")).toHaveTextContent("1");
  });

  it("keeps journal Contents and ticks aligned to Slate body headings", () => {
    render(<JournalFolioHarness />);
    const container = screen.getByTestId("journal-container");
    const contents = screen.getByRole("navigation", { name: "Contents" });
    const ticks = screen.getByRole("navigation", {
      name: "Reading position",
    });

    fireEvent.click(within(contents).getByRole("button", { name: "09:07" }));
    expect(container.scrollTop).toBe(600 - 16);
    expect(screen.getByTestId("journal-active")).toHaveTextContent("0");

    fireEvent.click(
      within(ticks).getByRole("button", {
        name: "1.1 Ordinary section",
      }),
    );
    expect(container.scrollTop).toBe(1200 - 16);
    expect(screen.getByTestId("journal-active")).toHaveTextContent("1");
  });
});
