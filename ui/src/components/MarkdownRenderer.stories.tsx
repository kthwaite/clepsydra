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
