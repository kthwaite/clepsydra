import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { createEditor, type Descendant } from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { decorateCode } from "#/editor/decorate-code";
import { renderElement } from "#/editor/elements/renderElement";
import { renderLeaf } from "#/editor/elements/renderLeaf";
import { makeBlockquote } from "./elements/blockquote";
import { makeBlockRef } from "./elements/blockRef";
import { makeCodeBlock } from "./elements/codeBlock";
import { makeFootnoteDef } from "./elements/footnoteDef";
import { makeFootnoteRef } from "./elements/footnoteRef";
import { makeHeading } from "./elements/heading";
import { makeLink } from "./elements/link";
import {
  makeBulletedList,
  makeListItem,
  makeNumberedList,
} from "./elements/list";
import { makeParagraph } from "./elements/paragraph";
import { makeThematicBreak } from "./elements/thematicBreak";
import { makeWikilink } from "./elements/wikilink";
import { withSchema } from "./withSchema";

// ---------------------------------------------------------------------------
// Harness
//
// Schema elements can't render standalone — each descriptor's `render` expects
// Slate's RenderElementProps. These stories mount a read-only Slate editor and
// dispatch through the production `renderElement`, so every story shows the
// *actual* element output. `withSchema` is applied so inline/void elements
// (wikilink, link, block-ref, footnote-ref) are classified correctly.
//
// A few elements reach into app context: block-ref hits TanStack Query
// (`useBlock`) and the link/wikilink/block-ref open-handlers call `useNavigate`.
// The providers below satisfy those without a backend (queries just resolve to
// undefined data, which is the element's natural "unresolved" state).
// ---------------------------------------------------------------------------

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function SchemaPreview({ value }: { value: Descendant[] }) {
  const editor = useMemo(
    () => withReact(withHistory(withSchema(createEditor()))),
    [],
  );
  return (
    <Slate editor={editor} initialValue={value}>
      <Editable
        readOnly
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        decorate={decorateCode}
        className="max-w-2xl font-body text-ink outline-none"
      />
    </Slate>
  );
}

/** Wrap a preview in the router + query providers the elements depend on. */
function renderWithProviders(value: Descendant[]) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SchemaPreview value={value} />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceRoute]),
    history: createMemoryHistory(),
  });

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

/** A paragraph wrapping an inline element, padded with the empty text nodes
 *  Slate requires on either side of an inline. */
function inlineInParagraph(inline: Descendant): Descendant {
  return makeParagraph({ children: [{ text: "" }, inline, { text: "" }] });
}

const meta: Meta = {
  title: "Editor/Schema Elements",
};

export default meta;
type Story = StoryObj;

// --- Block elements ---------------------------------------------------------

export const Paragraph: Story = {
  render: () =>
    renderWithProviders([
      makeParagraph({
        children: [
          { text: "A plain paragraph with " },
          { text: "bold", bold: true },
          { text: ", " },
          { text: "italic", italic: true },
          { text: ", and " },
          { text: "code", code: true },
          { text: " marks." },
        ],
      }),
    ]),
};

export const Heading: Story = {
  render: () =>
    renderWithProviders(
      ([1, 2, 3, 4, 5, 6] as const).map((level) =>
        makeHeading({
          level,
          children: [{ text: `Heading level ${level}` }],
        }),
      ),
    ),
};

export const CodeBlock: Story = {
  render: () =>
    renderWithProviders([
      makeCodeBlock({
        language: "rust",
        children: [
          { text: 'fn main() {\n    println!("hello, clepsydra");\n}' },
        ],
      }),
    ]),
};

export const Blockquote: Story = {
  render: () =>
    renderWithProviders([
      makeBlockquote({
        children: [
          { text: "Knowledge is of two kinds. We know a subject ourselves," },
        ],
      }),
    ]),
};

export const BulletedList: Story = {
  render: () =>
    renderWithProviders([
      makeBulletedList({
        children: [
          makeListItem({
            children: [makeParagraph({ children: [{ text: "First item" }] })],
          }),
          makeListItem({
            children: [makeParagraph({ children: [{ text: "Second item" }] })],
          }),
        ],
      }),
    ]),
};

export const NumberedList: Story = {
  render: () =>
    renderWithProviders([
      makeNumberedList({
        children: [
          makeListItem({
            children: [makeParagraph({ children: [{ text: "Step one" }] })],
          }),
          makeListItem({
            children: [makeParagraph({ children: [{ text: "Step two" }] })],
          }),
        ],
      }),
    ]),
};

export const ListItemTask: Story = {
  name: "List Item (task checkboxes)",
  render: () =>
    renderWithProviders([
      makeBulletedList({
        children: [
          makeListItem({
            checked: true,
            children: [makeParagraph({ children: [{ text: "Done task" }] })],
          }),
          makeListItem({
            checked: false,
            children: [makeParagraph({ children: [{ text: "Open task" }] })],
          }),
        ],
      }),
    ]),
};

export const ThematicBreak: Story = {
  render: () =>
    renderWithProviders([
      makeParagraph({ children: [{ text: "Above the divider." }] }),
      makeThematicBreak({}),
      makeParagraph({ children: [{ text: "Below the divider." }] }),
    ]),
};

export const FootnoteDef: Story = {
  name: "Footnote Definition",
  render: () =>
    renderWithProviders([
      makeFootnoteDef({
        identifier: "1",
        children: [
          makeParagraph({
            children: [{ text: "The referenced footnote body." }],
          }),
        ],
      }),
    ]),
};

// --- Inline elements (wrapped in a paragraph) -------------------------------

export const Wikilink: Story = {
  render: () =>
    renderWithProviders([
      inlineInParagraph(
        makeWikilink({ target: "clepsydra", alias: "the vessel" }),
      ),
    ]),
};

export const Link: Story = {
  render: () =>
    renderWithProviders([
      inlineInParagraph(
        makeLink({
          url: "https://example.com",
          children: [{ text: "an external link" }],
        }),
      ),
    ]),
};

export const BlockRef: Story = {
  name: "Block Reference",
  render: () =>
    renderWithProviders([
      inlineInParagraph(makeBlockRef({ blockId: "a1b2c3d4" })),
    ]),
};

export const FootnoteRef: Story = {
  name: "Footnote Reference",
  render: () =>
    renderWithProviders([
      makeParagraph({
        children: [
          { text: "Text with a footnote marker" },
          makeFootnoteRef({ identifier: "1" }),
          { text: "." },
        ],
      }),
      makeFootnoteDef({
        identifier: "1",
        children: [
          makeParagraph({
            children: [{ text: "Hover the marker to preview this." }],
          }),
        ],
      }),
    ]),
};
