import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsToc } from "#/components/docs/DocsToc";
import type { DocTocEntry } from "#/docs/toc";

// jsdom computes no layout, so container geometry is stubbed at the prototype
// level the same way the Folio scrollspy tests do it: the article container
// reports a fixed viewport and every heading derives its viewport-relative
// rect from a data-offset attribute minus the container's scrollTop.
const CLIENT_HEIGHT = 600;
const SCROLL_HEIGHT = 2600;
const MAX_SCROLL = SCROLL_HEIGHT - CLIENT_HEIGHT;
const TITLE_OFFSET = 40;
const HEADING_OFFSETS = [100, 600, 1200, 1900];

const ENTRIES: readonly DocTocEntry[] = [
  { depth: 2, text: "Prerequisites", id: "prerequisites" },
  { depth: 3, text: "Install the binary", id: "install-the-binary" },
  { depth: 4, text: "Verify the install", id: "verify-the-install" },
  { depth: 2, text: "Related", id: "related" },
];

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

function Harness({
  entries = ENTRIES,
  onNavigate,
}: {
  entries?: readonly DocTocEntry[];
  onNavigate?: () => void;
}) {
  const containerRef = useRef<HTMLElement>(null);

  return (
    <>
      <main ref={containerRef} data-scroll-container data-testid="article-main">
        <article>
          <h1 data-offset={TITLE_OFFSET}>Getting Started</h1>
          {ENTRIES.map((entry, index) => {
            const Tag = `h${entry.depth}` as "h2" | "h3" | "h4";
            return (
              <Tag
                key={entry.id}
                id={entry.id}
                data-offset={HEADING_OFFSETS[index]}
              >
                {entry.text}
              </Tag>
            );
          })}
        </article>
      </main>
      <DocsToc
        entries={entries}
        containerRef={containerRef}
        onNavigate={onNavigate}
      />
    </>
  );
}

function tocButtons() {
  const nav = screen.getByRole("navigation", { name: "On this page" });
  return within(nav).getAllByRole("button");
}

describe("DocsToc", () => {
  it("lists every heading in document order under a labeled rail", () => {
    render(<Harness />);

    expect(tocButtons().map((button) => button.textContent)).toEqual(
      ENTRIES.map((entry) => entry.text),
    );
  });

  it("indents each entry by its heading depth", () => {
    render(<Harness />);

    expect(tocButtons().map((button) => button.style.paddingLeft)).toEqual([
      "8px",
      "16px",
      "24px",
      "8px",
    ]);
  });

  it("marks only the heading the reader is on", () => {
    render(<Harness />);
    const buttons = tocButtons();

    expect(buttons[0]).toHaveAttribute("aria-current", "location");
    for (const button of buttons.slice(1)) {
      expect(button).not.toHaveAttribute("aria-current");
    }
  });

  it("scrolls the article to a chosen heading and moves the current marker to it", () => {
    render(<Harness />);
    const container = screen.getByTestId("article-main");

    fireEvent.click(screen.getByRole("button", { name: "Verify the install" }));

    // the h1 title is excluded, so entry 2 is the third body heading (1200px),
    // parked JUMP_OFFSET above its own trigger band
    expect(container.scrollTop).toBe(HEADING_OFFSETS[2] - 16);
    expect(
      screen.getByRole("button", { name: "Verify the install" }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      screen.getByRole("button", { name: "Prerequisites" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("reports the choice to its host so a drawer can close", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Related" }));

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("renders no rail for a document without headings", () => {
    render(<Harness entries={[]} />);

    expect(
      screen.queryByRole("navigation", { name: "On this page" }),
    ).not.toBeInTheDocument();
  });
});
