import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  highlightMatch,
  plainWikiText,
} from "#/components/codex/highlightMatch";

function marks(text: string, needles: string[]) {
  const { container } = render(<p>{highlightMatch(text, needles)}</p>);
  return {
    text: container.textContent,
    marks: Array.from(container.querySelectorAll("mark")).map(
      (m) => m.textContent,
    ),
    container,
  };
}

describe("highlightMatch", () => {
  it("wraps a case-insensitive match in an accent-tint mark", () => {
    const r = marks("builds on ctesibius here", ["Ctesibius"]);
    expect(r.marks).toEqual(["ctesibius"]);
    expect(r.text).toBe("builds on ctesibius here");
    expect(r.container.querySelector("mark")).toHaveClass("bg-accent-tint");
  });

  it("wraps every occurrence of every needle", () => {
    const r = marks("Hero and hero, then Heron", ["hero", "Heron"]);
    expect(r.marks).toEqual(["Hero", "hero", "Heron"]);
  });

  it("ignores empty needles and returns plain text when nothing matches", () => {
    const r = marks("no match here", ["", "absent"]);
    expect(r.marks).toEqual([]);
    expect(r.text).toBe("no match here");
  });

  it("treats regex metacharacters literally", () => {
    const r = marks("see [[a.b]] and axb", ["[[a.b]]"]);
    expect(r.marks).toEqual(["[[a.b]]"]);
  });

  it("renders markup in the text as text, never as HTML", () => {
    const r = marks("<b>bold</b> Alpha", ["Alpha"]);
    expect(r.container.querySelector("b")).toBeNull();
    expect(r.text).toBe("<b>bold</b> Alpha");
  });
});

describe("plainWikiText", () => {
  it("reads wikilinks as their display text", () => {
    expect(plainWikiText("see [[Alpha]] and [[Beta page|beta]] here")).toBe(
      "see Alpha and beta here",
    );
  });

  it("drops heading and block anchors from the display text", () => {
    expect(plainWikiText("[[Alpha#Intro]] and [[Beta^b1]]")).toBe(
      "Alpha and Beta",
    );
  });

  it("leaves text without wikilinks unchanged", () => {
    expect(plainWikiText("plain [text] here")).toBe("plain [text] here");
  });
});
