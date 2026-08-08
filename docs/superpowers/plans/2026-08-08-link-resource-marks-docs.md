# Link Resource Marks Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document automatic external resource marks in the user-facing Getting Started guide.

**Architecture:** Add one explanatory section immediately after the existing Wikilinks section in the MDX guide. Documentation describes the rendered affordance and representative resource families without changing Markdown syntax, stored content, or implementation behavior.

**Tech Stack:** MDX, React documentation renderer, Vitest documentation smoke tests.

## Global Constraints

- Keep the update concise and user-facing.
- State that marks are automatic and decorative.
- State that stored Markdown, labels, URLs, accessibility names, and copied text are unchanged.
- Explain service identity precedence over generic file-extension marks.
- Do not introduce or recommend the `!W` authoring shortcut.
- Do not enumerate implementation-only `data-link-resource` metadata.

---

### Task 1: Add Getting Started resource-mark guidance

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx` immediately after the `## Wikilinks` section and before `## 9) Optional: Edit the vault from Neovim (LSP)`.
- Test: `ui/src/docs/mdx-smoke.test.tsx` (existing MDX compilation and source smoke coverage).

**Interfaces:**
- Consumes: Existing documentation prose and `docsMdxComponents` link rendering.
- Produces: A discoverable “External resource marks” section at `/docs/getting-started`.

- [ ] **Step 1: Add the user-facing section**

Use this content, preserving the existing heading order:

```mdx
## External resource marks

Clepsydra adds a small decorative mark to recognized external links in the web
UI. The mark is automatic: your Markdown, link label, URL, accessible link
name, and copied text stay unchanged.

For example:

```markdown
[Wikipedia](https://en.wikipedia.org/wiki/Hypertext)
[An arXiv paper](https://arxiv.org/pdf/1706.03762.pdf)
```

Recognized service families include Wikipedia and Wikimedia, arXiv, bioRxiv,
DOI, PubMed, Semantic Scholar, GitHub, GitLab, Internet Archive, YouTube, and
Vimeo. Direct PDF, audio, video, and image links receive file-type marks. A
specific service takes precedence over a generic file extension, so an arXiv
PDF receives the arXiv mark rather than the generic PDF mark.
```

Do not add `!W` syntax, resource metadata, or a second link-authoring format.

- [ ] **Step 2: Run the documentation smoke test**

Run:

```bash
bun run --cwd ui test -- src/docs/mdx-smoke.test.tsx
```

Expected: the MDX smoke test passes and the guide still exposes its existing
metadata and source content.

- [ ] **Step 3: Run documentation validation gates**

Run:

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the documentation change**

```bash
git add ui/src/docs/content/getting-started.mdx
git commit -m "docs: explain external resource marks"
```
