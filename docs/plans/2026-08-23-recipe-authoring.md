# Recipe authoring — grouped sections, heading format, paste-friendly editing

Status: design agreed 2026-08-23. Not yet implemented.

## Why

Three recipes exist in the vault. One of them — `double-black-bean-stew`,
authored the day this spec was written — does not open in the structured recipe
editor at all, because its steps carry indented detail lines and the codec
rejects them as `unsupported-content`. The other two use a bare-marker,
`•`-bulleted body that is not portable Markdown and is not what anyone writes by
hand or pastes from a website.

Four problems, all in the authoring path:

1. A new RECIPE page is created with an empty body, so it opens in the raw
   Markdown fallback with no sections to fill in.
2. The canonical written form uses bare `INGREDIENTS` markers and `•` bullets
   rather than headings and standard list markers.
3. A dish with components (a sauce, a dough, an assembly) has nowhere to put
   them — ingredients and steps are flat lists.
4. The edit view is a stack of one-line inputs. Pasting eight ingredients from a
   website lands all eight in a single field.

## Decisions

| Question | Decision |
| --- | --- |
| Subsections | Optional `###` groups inside `## Ingredients` / `## Steps`; loose items before the first group are allowed; the two sections group independently |
| Written format | Always h2 sections, `-` ingredient bullets, `1.` steps |
| Legacy bodies | Bare-marker `•` form stays readable forever; the app rewrites one only on an explicit structured save. The one-off migration below is the single deliberate exception |
| Step numbering | Restarts at 1 in each group |
| Multi-line steps | Supported — a lead line plus indented continuation lines, kept as one opaque string. Ingredients stay single-line |
| Scaffold | Written by the backend on create, so INTAKE, MCP, and the CLI all get it |
| Scaffold contents | The three headings only. Placeholder text lives in the editor, never in the file |
| Edit UX | One textarea per group, one item per line. No per-row inputs or move buttons |
| Migration | A throwaway script over the three existing files. Nothing shipped |

## Data model

`ui/src/recipe/recipeCodec.ts`:

```ts
export type RecipeGroup = { name: string | null; items: string[] };

export type RecipeDocument = {
  description: string;
  ingredientGroups: RecipeGroup[];
  stepGroups: RecipeGroup[];
  notesMarkdown: string;
};
```

**Invariant:** `groups[0].name === null` always. The unnamed lead group exists
even when empty; every group after it is named. A flat recipe is one lead group.
This makes "remove a group" a merge into its predecessor and gives the edit view
a lead textarea it can always render.

`ingredients` and `steps` are renamed to `ingredientGroups` and `stepGroups` so
every consumer is forced to acknowledge the shape change rather than silently
iterating strings.

## On-disk format

### Written

```markdown
Clean, clear chicken broth with charred aromatics. Makes four bowls.

## Ingredients

- 200g flour

### For the sauce

- 2 tomatoes
- 1 clove garlic

## Steps

1. Make the dough.
   Rest it 30 minutes under a cloth.
2. Heat the oven to 240C.

### For the sauce

1. Blanch the tomatoes.
2. Blend.

## Notes

**Batch-friendly**: the broth freezes well.
```

- Named groups are emitted even when empty. The lead group is emitted only when
  it has items.
- Step continuation lines are indented by the width of their own marker
  (`"1. "` → 3 spaces, `"10. "` → 4), so relative indent inside a step survives.
  A blank line inside a step is emitted as a genuinely empty line, never as
  whitespace.
- Description is omitted when empty. `## Notes` is always emitted, with nothing
  after it when the notes are empty. One trailing newline.

### Read, additionally

- The legacy form: bare `INGREDIENTS` / `STEPS` / `NOTES` markers, `•` bullets,
  no groups.
- h2-form variants using `*`, `+`, or `•` bullets and `N)` step markers.

## Codec rules

Two behaviours carry over untouched: a first body line that exactly matches the
trimmed page title is still dropped into nothing rather than becoming
description, and the `RecipeParseFailure` union gains no new members — a bad
group heading depth reports the existing `unsupported-content`. `sourceFormat`
stays on a successful parse result; it records which form was read, and no
longer has any bearing on what is written.

### Section markers

1. Collect every candidate marker: a bare `ingredients|steps|notes` line, or a
   `#{1,6} ingredients|steps|notes` heading. Matching is case-insensitive.
2. The **first** candidate fixes `sourceFormat` and, for the Markdown form,
   `sectionDepth`. Candidates at any other depth or in the other format are
   rejected as section markers and fall through to section content.
3. Stop collecting once the `notes` marker at `sectionDepth` is reached with
   `ingredients` and `steps` already found, so headings inside the notes prose
   are never mistaken for section markers.
4. A section absent from the accepted set but present among the rejected
   candidates → `mixed-format`. Absent from both → `missing-section`. Then the
   existing `duplicate-section` and `section-order` checks run unchanged.

Consequence worth naming: a `### Notes` heading inside the Steps section is a
group named "Notes", not a section marker. That is the intended reading.

Known limitation: because the first candidate fixes the depth, a stray
`### Ingredients` heading in the description would mis-anchor the parse. Our own
serialiser never emits a group heading before `## Ingredients`, and the
description is prose, so this does not arise in practice. The recipe falls back
to raw Markdown rather than corrupting anything.

### Groups

Within the Ingredients and Steps regions, in the Markdown form only:

- A heading at exactly `sectionDepth + 1` with non-empty text opens a named
  group.
- A heading at any other depth → `unsupported-content` → fallback.
- Lines before the first group heading belong to the lead group.
- Duplicate group names are permitted; they are labels, not keys.

The legacy bare-marker form has no groups. A heading line inside it is
`unsupported-content`, as it already is today.

### Ingredient items

Unchanged except for leniency: `^[-*+•]\s+(.+)$` in both formats. A leading
`[ ]` or `[x]` task marker is `unsupported-content` in the heading format only;
in the legacy bare-marker format such text stays opaque, unchanged from today
(unifying the two would change how bodies already on disk parse, contrary to
legacy bodies staying readable and rewritten only on an explicit structured
save). An indented
line is `unsupported-content`. A bullet-or-digit line that does not match is
`invalid-ingredient`.

### Step items

One parser for both formats:

- `^\d+[.)]\s+(.+)$` starts a step.
- Subsequent indented non-blank lines continue it. The minimum indent across a
  step's continuation lines is stripped from each, preserving relative indent.
- A blank line is held pending: it is committed into the step only if another
  indented line follows. Trailing blanks are dropped.
- An indented line with no step open → `unsupported-content`.
- An unindented non-blank line that is not a step marker → `invalid-step` if it
  looks like a list item, `unsupported-content` otherwise.

### Serialisation

Always the written form above. Items whose text trims to empty are dropped. A
group whose name trims to empty has its items merged into the preceding group,
so clearing a group name in the editor is a predictable un-grouping rather than
an invalid document.

**Round-trip property:** for any document, `parse(serialize(d))` equals `d`
after dropping empty items and merging empty-named groups.

## Views

`ui/src/components/codex/recipe/RecipeFolioBody.tsx`.

### Read

Two columns as today. Each column renders the lead group's items, then each
named group under an `h3` subhead. Step numbering restarts at 1 in each group.
Notes remain a Markdown block below.

### Edit

The per-row inputs and the add / up / down / delete buttons are removed
entirely. Each of Ingredients and Steps renders:

- a lead textarea,
- then, per named group, a name input, a textarea, and **Remove group**,
- then an **Add group** button.

Reordering is line editing inside a textarea. Removing a group merges its items
into the preceding group, so nothing is destroyed by a misclick.

Textarea semantics:

- **Ingredients** — one item per line. A leading `-`, `*`, `+`, `•`, `N.`, or
  `N)` is stripped when the text is read into items, so a block pasted from a
  website lands clean.
- **Steps** — an unindented line starts a step; indented lines continue it. Step
  numbers are *not* rendered into the textarea. They exist only in the file and
  the read view, so typing never fights renumbering.

Each textarea holds local draft text and re-derives its value from the document
only when it is not focused. Parsing on every keystroke while re-rendering the
value would move the caret.

Placeholders: `what the dish is, yield, timing` (description), `200g flour`
(ingredients), `what to do first` (steps), `substitutions, make-ahead, storage`
(notes).

## Scaffold on create

`create_page` in `src/api/pages.rs`: when the declared kind is `RECIPE` and the
request body is absent or whitespace-only, the page body becomes

```
## Ingredients

## Steps

## Notes
```

with a trailing newline. That parses cleanly into a document with three empty
lead groups, so the page opens structured. One place covers the INTAKE modal,
`vault_create_page`, and the CLI; `InscribeModal.tsx` needs no change.

Separately, `Folio.tsx` treats a RECIPE page whose body trims to empty as an
empty `RecipeDocument` rather than showing the preservation notice. That covers
pages assigned `RECIPE` after the fact, and pages created before this change.

Unchanged: a recipe body containing block ids still forces the generic editor.

## Migration

A throwaway script in the scratchpad, not committed. For each `.md` under the
vault's `recipes/` folder it splits frontmatter from body, runs the body through
`parseRecipeMarkdown` and `serializeRecipeMarkdown`, and writes it back.

Expected outcome for the current corpus:

| File | Change |
| --- | --- |
| `masoor-dal-with-tadka-on-demand` | bare markers and `•` → h2 and `-` |
| `ph-g-hanoi-style-chicken-pho` | same, and its duplicated title line is dropped |
| `double-black-bean-stew` | `*` → `-`; multi-line steps now parse, so it gains structured editing |

Selection is by folder, not by frontmatter: the phở file has no `type =`
declaration and takes its kind from the folder.

## Testing

`ui/src/recipe/recipeCodec.test.ts` is largely rewritten. Cases:

- Flat h2 recipe parses; legacy bare-marker recipe parses; both serialise to the
  h2 form.
- Groups: lead-only, lead plus named groups, named groups only, empty named
  group, duplicate group names.
- Group heading at the wrong depth → `unsupported-content`.
- `### Notes` inside Steps is a group, not a section marker.
- Multi-line steps: continuation lines, relative indent preserved, interior
  blank line preserved, trailing blanks dropped, indented line with no step open
  → `unsupported-content`.
- Step numbering restarts per group on serialise; `N)` markers accepted on read.
- Bullet leniency: `-`, `*`, `+`, `•` all accepted; task items rejected.
- Error precedence preserved: `mixed-format`, `missing-section`,
  `duplicate-section`, `section-order`.
- Round-trip property over a fixture corpus, including the three real vault
  bodies.
- The scaffold body parses into three empty lead groups.

`RecipeFolioBody.test.tsx`: textarea round-trip; multi-line paste into the
ingredients textarea produces one item per line with markers stripped; add
group; rename group; remove group merges into the predecessor; clearing a group
name un-groups on save; steps textarea shows no numbers; read view restarts
numbering per group.

`FolioRecipe.test.tsx`: an empty RECIPE body opens structured rather than in
fallback; a body with block ids still uses the generic editor.

`tests/api_test.rs`: creating a RECIPE page with no body writes the scaffold;
creating one with a body leaves it alone; creating a non-RECIPE page with no
body is unaffected.

Gates: `bun run typecheck`, `bun run lint`, `bun run test` in `ui/`, and
`cargo test`, `cargo clippy` at the root.

## Files touched

| File | Change |
| --- | --- |
| `ui/src/recipe/recipeCodec.ts` | major — groups, multi-line steps, h2 serialisation |
| `ui/src/recipe/recipeCodec.test.ts` | major rewrite |
| `ui/src/components/codex/recipe/RecipeFolioBody.tsx` | major — textarea authoring, groups |
| `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx` | rewrite |
| `ui/src/components/codex/Folio.tsx` | empty-body tolerance, projection literal |
| `ui/src/components/codex/__tests__/FolioRecipe.test.tsx` | update |
| `src/api/pages.rs` | scaffold on create |
| `tests/api_test.rs` | scaffold tests |
| `ui/src/docs/content/recipes.mdx` | rewrite the format and editing sections |

## Out of scope

- A Rust port of the codec, and any shipped `clep` normalisation command. The
  corpus is three files; a throwaway script settles it.
- Continuation lines for ingredients. They stay single-line.
- Shared component names across Ingredients and Steps. The two sections group
  independently.
- Any parsing of quantities, units, scaling, or conversion. Ingredients and
  steps remain opaque strings.
