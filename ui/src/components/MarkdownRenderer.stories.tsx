import type { Meta, StoryObj } from "@storybook/react-vite";
import { MarkdownRenderer } from "./MarkdownRenderer";

const meta: Meta<typeof MarkdownRenderer> = {
  title: "Components/MarkdownRenderer",
  component: MarkdownRenderer,
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
