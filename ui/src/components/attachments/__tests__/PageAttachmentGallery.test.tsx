import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { AttachmentInfo } from "#/api/attachments";
import { $api } from "#/api/client";
import {
  PageAttachmentGallery,
  PageAttachmentSection,
} from "#/components/attachments/PageAttachmentGallery";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";

const inventory: AttachmentInfo[] = [
  "inline.png",
  "café.png",
  "footer.png",
  "paper.pdf",
  "manual.pdf",
  "unassociated.png",
].map((name) => ({ name, path: name, vault_path: `media/${name}`, size: 128 }));

function renderPage({
  markdown = "",
  attachedPaths = [],
  children,
}: {
  markdown?: string;
  attachedPaths?: string[];
  children?: ReactNode;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    $api.queryOptions("get", "/api/vault/attachments", {}).queryKey,
    inventory,
  );
  return render(
    <QueryClientProvider client={client}>
      <PageAttachmentGallery
        pagePath="notes/current.md"
        markdown={markdown}
        attachedPaths={attachedPaths}
      >
        <MarkdownRenderer content={markdown} onOpenPage={() => {}} />
        {children}
        <PageAttachmentSection />
      </PageAttachmentGallery>
    </QueryClientProvider>,
  );
}

describe("page attachment gallery", () => {
  it("shows only explicitly attached files absent from prose, ignoring code examples and missing references", () => {
    renderPage({
      markdown: [
        "![Inline](../media/inline.png)",
        "[Paper][paper]",
        "[Photo](/api/vault/attachments/caf%C3%A9.png)",
        "`![Example](/api/vault/attachments/footer.png)`",
        "```md",
        "[Manual](/api/vault/attachments/manual.pdf)",
        "```",
        "",
        "[paper]: ../media/paper.pdf",
      ].join("\n"),
      attachedPaths: [
        "inline.png",
        "cafe\u0301.png",
        "paper.pdf",
        "footer.png",
        "footer.png",
        "manual.pdf",
        "missing.png",
      ],
    });
    const footer = within(
      screen.getByRole("region", { name: "Page attachments" }),
    );
    expect(footer.getAllByRole("img")).toHaveLength(1);
    expect(footer.getByRole("img", { name: "footer.png" })).toBeVisible();
    expect(
      footer.getByRole("link", { name: "Open manual.pdf" }),
    ).toHaveAttribute("href", "/api/vault/attachments/manual.pdf");
    expect(
      footer.getByRole("link", { name: "Download manual.pdf" }),
    ).toHaveAttribute("download", "manual.pdf");
    expect(footer.queryByText("unassociated.png")).toBeNull();
    expect(footer.queryByText("paper.pdf")).toBeNull();
    expect(screen.getByRole("img", { name: "Inline" })).toHaveAttribute(
      "src",
      "/api/vault/attachments/inline.png",
    );
  });

  it("hides the footer when nothing unreferenced is explicitly attached", () => {
    renderPage({
      markdown: "![Inline](/api/vault/attachments/inline.png)",
      attachedPaths: ["inline.png", "missing.png"],
    });
    expect(
      screen.queryByRole("region", { name: "Page attachments" }),
    ).toBeNull();
  });
});

it("shares inline and footer images in document order, wraps, resets zoom and restores focus", async () => {
  const user = userEvent.setup();
  renderPage({
    markdown:
      "![First](../media/inline.png)\n\n![Second](../media/cafe%CC%81.png)\n\n![Duplicate](/api/vault/attachments/inline.png)",
    attachedPaths: ["footer.png", "inline.png", "café.png"],
  });
  const trigger = screen.getByRole("button", { name: "Open image: Second" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Image gallery" });
  expect(within(dialog).getByText("café.png")).toBeVisible();
  expect(within(dialog).getByText("2 of 3")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Zoom in" }));
  expect(within(dialog).getByText("125%")).toBeVisible();
  await user.keyboard("{ArrowRight}");
  expect(within(dialog).getByText("footer.png")).toBeVisible();
  expect(within(dialog).getByText("3 of 3")).toBeVisible();
  expect(within(dialog).getByText("100%")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Next image" }));
  expect(within(dialog).getByText("inline.png")).toBeVisible();
  expect(within(dialog).getByText("1 of 3")).toBeVisible();
  // Navigation works even before focus has reached a control.
  dialog.focus();
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(within(dialog).getByText("footer.png")).toBeVisible();
  for (let index = 0; index < 9; index += 1) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(
    screen.getByRole("button", { name: "Open image: footer.png" }),
  );
  expect(within(screen.getByRole("dialog")).getByText("3 of 3")).toBeVisible();
});
