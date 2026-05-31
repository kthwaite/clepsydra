# Clepsydra

A personal knowledge-management system ("digital garden"): a Rust-indexed
markdown vault with a React reader/editor. This glossary fixes the vocabulary
of the domain; it is not a spec.

## Language

**Page**:
A single markdown file in the vault. Its identity is a stable frontmatter UUID;
its `path` is non-identifying (a projection of its kind/project metadata) and its
filename is a stable, globally-unique human handle. Carries YAML frontmatter and
a body.
_Avoid_: Note (reserved for the NOTE kind), document, file.

**Kind**:
The single type discriminator of a Page, drawn from a closed, code-defined
enum (NOTE, PROJECT, JOURNAL, TODO, QUOTE, BOOK, CAPTURE, CODE, PERSON). A Page
has exactly one kind; it selects the frontend renderer and is
the top-level axis of the Page's folder location. Each kind maps one-to-one to a
canonical folder (lowercase plural: `notes/`, `projects/`, `journals/`,
`todos/`, …). NOTE is the default and lives in `notes/`.
_Avoid_: Category, type, class.

**Todo**:
The TODO kind — a standalone actionable item, in `todos/`.
_Avoid_: Task (reserved for a planned per-project sub-kind, not yet designed).

**Capture**:
The CAPTURE kind — a snippet drawn from *outside* the operator's own writing (a
clipping, excerpt, or quotation captured from an external source), in
`captures/`. Distinguished from authored Pages by its external provenance.

**Project**:
An optional, free-form, user-created label on a Page that forms a single level
of subfolder beneath its kind. A Page belongs to at most one project. Pages of
any kind may share a project; its members are gathered logically by the label,
not physically in one folder (they live in `<kind>/<project>/` across many
kinds).
_Avoid_: Category, group, collection, tag.

**Declared kind**:
A kind written explicitly in a Page's frontmatter `type:`. Authoritative.

**Inferred kind**:
The kind the system resolves for a Page that has no `type:` in frontmatter,
read from its folder location (else NOTE). Shown greyed in the UI; the API
marks it as inferred.

**Tag**:
A free-form topical label on a Page. Many per Page. Orthogonal to kind and
project — tags classify subject matter, they do not move the Page.
_Avoid_: Category, keyword.

**Drift**:
The state of a Page whose folder location disagrees with the projection of its
declared kind/project (e.g. `type: quote` in frontmatter while the file sits in
`projects/`). Kind resolution stays correct (declared wins); only the layout
invariant is violated. Healed by Reconcile.

**Reconcile**:
The idempotent operation that moves a drifted Page to the folder its declared
metadata projects, rewriting affected links. Fired on UI assignment, LSP save,
and a `serve`-startup sweep.

**Orphan**:
A Page with zero *inbound* links — nothing links to it. The canonical meaning.
_Avoid_: using "orphan" for unresolved links or for isolated pages.

**Unresolved link**:
A wikilink whose target Page does not exist (a dangling reference). Counts
links, not pages — never call this "orphans."

**Isolated page**:
A Page with no links inbound *or* outbound — fully disconnected from the graph.
Distinct from an Orphan (which may still link outward).
