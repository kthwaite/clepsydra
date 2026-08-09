import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { docsMdxComponents } from "#/components/docs/DocsMdxComponents";
import BooksAndReading, {
  meta as booksAndReadingMeta,
} from "#/docs/content/books-and-reading.mdx";
import BrowserExtension, {
  meta as browserExtensionMeta,
} from "#/docs/content/browser-extension.mdx";
import Configuration from "#/docs/content/configuration.mdx";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";
import Troubleshooting, {
  meta as troubleshootingMeta,
} from "#/docs/content/troubleshooting.mdx";
import { DOC_PAGES } from "#/docs/registry";

it("compiles MDX, preserves typed metadata, and exposes raw source", () => {
  render(<Guide />);
  expect(
    screen.getByRole("heading", { name: "Prerequisites" }),
  ).toHaveAttribute("id", "prerequisites");
  expect(meta.slug).toBe("getting-started");
  expect(source).toContain(
    "This guide gets Clepsydra running locally with an initialized vault.",
  );
});

it.each(DOC_PAGES)("renders the registered $slug guide component", async ({
  Component,
}) => {
  const { container } = render(<Component />);
  await waitFor(() => expect(container).not.toBeEmptyDOMElement());
});

it("links Getting Started to both dedicated guides", () => {
  render(<Guide />);

  expect(
    screen.getByRole("link", { name: "Browser Extension guide" }),
  ).toHaveAttribute("href", "/docs/browser-extension");
  expect(
    screen.getByRole("link", { name: "Troubleshooting guide" }),
  ).toHaveAttribute("href", "/docs/troubleshooting");
});

it("renders the dedicated troubleshooting guide", () => {
  render(<Troubleshooting />);
  expect(troubleshootingMeta.slug).toBe("troubleshooting");
  expect(
    screen.getByRole("heading", {
      name: "UI doesn’t load in single-binary mode",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("clep config path --trace")).toBeInTheDocument();
});

it("renders self-contained browser extension setup", () => {
  render(<BrowserExtension />);
  expect(browserExtensionMeta.slug).toBe("browser-extension");
  expect(
    screen.getByRole("heading", {
      name: "Install in Chrome, Chromium, Brave, or Edge",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("extension/dist", { exact: true }),
  ).toBeInTheDocument();
  expect(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: "Firefox: rebuild before reloading",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("HTTP 409", { exact: true })).toBeInTheDocument();
  expect(
    screen.getByText("notification only", { exact: true }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("on_content_changed", { exact: true }),
  ).toBeInTheDocument();
});

it("renders the Books and Reading workflow", () => {
  render(<BooksAndReading />);
  expect(booksAndReadingMeta.slug).toBe("books-and-reading");
  expect(
    screen.getByRole("heading", { name: "Scan a book barcode" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Add book by ISBN", { exact: true })).toHaveLength(
    2,
  );
  expect(
    screen.getByText("academic.books_folder", { exact: true }),
  ).toBeInTheDocument();
});

it("renders GFM tables as semantic HTML", () => {
  render(
    <Configuration
      components={{
        table: docsMdxComponents.table,
        th: docsMdxComponents.th,
        td: docsMdxComponents.td,
      }}
    />,
  );

  const table = screen.getAllByRole("table")[1];
  expect(table.closest('[role="region"]')).toHaveAccessibleName(
    "Scrollable table",
  );
  expect(
    within(table).getByRole("columnheader", { name: "Key" }),
  ).toBeInTheDocument();
  expect(
    within(table).getByRole("cell", { name: "attachment_folder" }),
  ).toBeInTheDocument();
});

it("renders repository-only guide references as non-clickable source paths", () => {
  render(<Configuration />);

  const references = screen.getAllByText("docs/encrypted-notes.md");
  expect(references).toHaveLength(2);
  for (const reference of references) {
    expect(reference).toHaveProperty("tagName", "CODE");
  }
  expect(
    screen.queryByRole("link", { name: "encrypted-notes.md" }),
  ).not.toBeInTheDocument();
});
