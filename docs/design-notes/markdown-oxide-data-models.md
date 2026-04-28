# Markdown-Oxide data model design decisions

Source: `../markdown-oxide` (Rust LSP server). Highlights focus on the in-memory data model and how it represents Obsidian-style Markdown vaults.

## Key decisions

- **Vault as the central in-memory model**
  `Vault` is the “in‑memory representation of the obsidian vault files,” exposing *selection* methods that behave like database queries and intentionally avoid interpretation/analysis. (`src/vault/mod.rs`, comment above `pub struct Vault`)
  It stores:
  - `md_files: MyHashMap<MDFile>` parsed file models
  - `ropes: MyHashMap<Rope>` for fast line/position access
  - `root_dir` for relative path semantics

- **Per‑file model normalized into parsed components**
  `MDFile` is a structured parse result for each markdown file, with explicit lists for references, headings, indexed blocks, tags, footnotes, link reference definitions, metadata, and code blocks (`MDFile` struct). Parsing is context‑sensitive (settings can disable parsing inside code blocks). (`MDFile::new`)

- **Two‑sided link model: References vs. Referenceables**
  - `Reference` represents *occurrences* of links/tags/etc in text; it’s an enum of concrete syntaxes (wiki links, markdown links, headings, blocks, tags, footnotes, link refs), all sharing `ReferenceData` (reference text, display text, range).
  - `Referenceable` represents *targets* that can be linked to: file, heading, block, tag, footnote, link ref definition, plus unresolved targets.
  This split lets the vault select “references” independently from “things that can be referenced.”

- **Referenceable as an enum (not a trait)**
  The comment above `Referenceable` explicitly says an enum was chosen to:
  1) avoid dynamic dispatch ergonomics,
  2) allow explicit differentiation between kinds, and
  3) include the path with each item.
  It also centralizes Obsidian‑specific link matching inside the vault module so other modules don’t need to know syntax details.

- **Unresolved referenceables are first‑class**
  `Vault::select_referenceable_nodes(None)` computes unresolved link targets by comparing references against resolved referenceable refnames, yielding `Unresolved*` variants for files/headings/blocks.

- **Obsidian‑style path semantics embedded in model**
  `get_obsidian_ref_path` strips extensions and makes paths relative to the vault root; `Referenceable::get_refname` uses it to build normalized refnames for matching.

- **Metadata model is minimal and focused**
  `MDMetadata` only models YAML frontmatter `aliases`, parsed via serde_yaml and regex. (`src/vault/metadata.rs`)

- **Hashable map wrapper for stable hashing**
  `MyHashMap` wraps `HashMap<PathBuf, T>` and implements `Hash` by sorting keys so the vault model can be hashed deterministically. (`src/vault/mod.rs`)

## Deeper pass

- **Regex-first parsing instead of a full Markdown AST**
  Core entities (links, headings, tags, blocks, footnotes, link refs) are parsed using targeted regexes (e.g., `Reference::new`, `MDHeading::new`, `MDTag::new`, `MDFootnote::new`, `MDLinkReferenceDefinition::new`). This keeps the model lightweight and focused on Obsidian-compatible syntax rather than full Markdown semantics. (`src/vault/mod.rs`)

- **Ranges are normalized through `MyRange` + `Rangeable`**
  `MyRange` wraps LSP `Range` and includes a byte→char conversion via Rope (`MyRange::from_range`). The `Rangeable` trait abstracts “anything with a range” for inclusion checks and position matching, used by references, headings, tags, blocks, etc. (`src/vault/mod.rs`)

- **Rope-based text storage for accurate positions**
  Vault stores a `Rope` per file to enable efficient line/offset mapping, essential for LSP range calculations and selection methods like `select_line`. (`src/vault/mod.rs`)

- **Code-block aware parsing rules**
  `MDCodeBlock` is parsed separately (long and inline code blocks). `MDFile::new` uses settings to exclude references/tags within code blocks for cleaner semantic indexing. (`src/vault/parsing.rs`, `src/vault/mod.rs`)

- **Reference parsing abstracts wiki vs markdown link syntax**
  `Reference` is created via a generic link constructor using a `ParseableReferenceConstructor` trait for wiki/markdown variants, unifying the model while preserving syntax differences. External URLs are explicitly ignored in reference parsing. (`src/vault/mod.rs`)

- **Reference matching centralizes Obsidian semantics**
  `Referenceable::matches_reference` implements matching logic (e.g., tag prefix matching for subtags, file-name vs path matching, footnote scoping to file). This keeps link resolution consistent and data-model-driven. (`src/vault/mod.rs`)

- **Block-level model is line-based**
  `Block` is computed from `Rope::lines()` and uses per-line ranges. This is a pragmatic model for block references (e.g., `^id`) rather than storing AST nodes. (`src/vault/mod.rs`)

- **Link reference definitions are first-class referenceables**
  Markdown link reference definitions (`[ref]: url`) are parsed into `MDLinkReferenceDefinition` and exposed as `Referenceable::LinkRefDef`, enabling references to behave like other linkable nodes. (`src/vault/mod.rs`)

- **Preview is data-model aware and type-specific**
  `Vault::select_referenceable_preview` returns different text slices depending on the referenceable type (file snippet, heading block, single line, etc.), implying preview logic is treated as part of the data model’s “read API.” (`src/vault/mod.rs`)
