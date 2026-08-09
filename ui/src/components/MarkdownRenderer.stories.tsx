import "katex/dist/katex.min.css";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { MarkdownRenderer } from "./MarkdownRenderer";

function createStoryRouter(content: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MarkdownRenderer content={content} />
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

  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceRoute]),
    history: createMemoryHistory(),
  });
}

const meta: Meta<typeof MarkdownRenderer> = {
  title: "Components/MarkdownRenderer",
  component: MarkdownRenderer,
  render: ({ content }) => (
    <RouterProvider router={createStoryRouter(content)} />
  ),
};

export default meta;
type Story = StoryObj<typeof meta>;

export const BasicMarkdown: Story = {
  args: {
    content: `# Hello World

This is a paragraph with **bold** and *italic* text.

## Lists

- Item one
- Item two
- Item three

## Code

\`\`\`rust
fn main() {
    println!("hello");
}
\`\`\`

Inline \`code\` here.

## Table

| Name | Value |
|------|-------|
| One  | 1     |
| Two  | 2     |

> A blockquote.
`,
  },
};

export const LinkResourceMarks: Story = {
  args: {
    content: `## Resource marks

[Wikipedia](https://en.wikipedia.org/wiki/Hypertext) · [arXiv](https://arxiv.org/abs/2401.00001) · [bioRxiv](https://biorxiv.org/content/10.1101/example) · [DOI](https://doi.org/10.1000/example) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/12345678/) · [Semantic Scholar](https://semanticscholar.org/paper/example)

[GitHub](https://github.com/example/project) · [GitLab](https://gitlab.com/example/project) · [Internet Archive](https://archive.org/details/example) · [YouTube](https://youtube.com/watch?v=example) · [Vimeo](https://vimeo.com/123)

[PDF](https://example.com/paper.pdf) · [audio](https://example.com/audio.flac) · [video](https://example.com/movie.webm) · [image](https://example.com/image.avif) · [ordinary external](https://example.com/page) · [internal](/pages/notes/example.md)

Wrapped sentence: Read [a deliberately long Wikipedia link label that approaches the edge of its container](https://en.wikipedia.org/wiki/Hypertext), then continue after punctuation. Adjacent: [one](https://github.com/a)[two](https://gitlab.com/b).`,
  },
  parameters: {
    layout: "padded",
  },
};

export const MathRenderingMatrix: Story = {
  args: {
    content: [
      "## TeX rendering matrix",
      "",
      "### Inline",
      "",
      String.raw`Dollar delimiters: $E = mc^2$. Backslash delimiters: \(a^2 + b^2 = c^2\), adjacent to punctuation.`,
      "",
      "### Display",
      "",
      "$$",
      String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}`,
      "$$",
      "",
      String.raw`\[`,
      String.raw`\frac{\partial}{\partial t}\rho + \nabla \cdot (\rho \mathbf{v}) = 0`,
      String.raw`\]`,
      "",
      "### Long display and fallbacks",
      "",
      String.raw`\[`,
      String.raw`\sum_{n=1}^{N}\left(\frac{\alpha_n^2 + \beta_n^2}{1 + \gamma_n^2}\right) = \frac{\prod_{k=1}^{N}(1 + \lambda_k)}{\sqrt{2\pi\sigma^2}}\exp\left(-\frac{(x-\mu)^2}{2\sigma^2}\right)`,
      String.raw`\]`,
      "",
      String.raw`Malformed TeX remains authored: \(\notACommand{\).`,
      "",
      "Inline code remains code: `$x$`.",
      "",
      "~~~tex",
      String.raw`\[`,
      String.raw`x^2 + y^2 = z^2`,
      String.raw`\]`,
      "~~~",
    ].join("\n"),
  },
  parameters: {
    layout: "padded",
  },
};
