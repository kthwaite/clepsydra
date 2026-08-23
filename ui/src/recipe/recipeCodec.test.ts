import { describe, expect, it } from "vitest";
import {
  parseRecipeMarkdown,
  serializeRecipeMarkdown,
} from "#/recipe/recipeCodec";

const example = `Phở Gà
Clear broth. Makes four bowls.

INGREDIENTS
• 1 whole chicken
• 2 onions

STEPS
1. Char the onions.
2. Simmer the chicken.

NOTES
**Batch-friendly**: Freeze the broth.
`;

const markdown = `Intro paragraph.

## Ingredients
- chicken
* onion
+ garlic

## Steps
1. Simmer.
2) Serve.

## Notes
Use **fresh** herbs.
`;

describe("parseRecipeMarkdown", () => {
  it("parses the demonstrated recipe format without duplicating the page title", () => {
    expect(parseRecipeMarkdown(example, "Phở Gà")).toEqual({
      ok: true,
      sourceFormat: "example",
      value: {
        description: "Clear broth. Makes four bowls.",
        ingredients: ["1 whole chicken", "2 onions"],
        steps: ["Char the onions.", "Simmer the chicken."],
        notesMarkdown: "**Batch-friendly**: Freeze the broth.",
      },
    });
  });

  it("parses standard Markdown headings and list markers case-insensitively", () => {
    expect(
      parseRecipeMarkdown(
        markdown
          .replace("## Ingredients", "## inGredients")
          .replace("## Steps", "## STEPS"),
        "Unrelated page title",
      ),
    ).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "Intro paragraph.",
        ingredients: ["chicken", "onion", "garlic"],
        steps: ["Simmer.", "Serve."],
        notesMarkdown: "Use **fresh** herbs.",
      },
    });
  });

  it("accepts empty standard-Markdown sections", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

## Steps

## Notes
`,
        "Empty recipe",
      ),
    ).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "",
        ingredients: [],
        steps: [],
        notesMarkdown: "",
      },
    });
  });

  it("normalizes CRLF and removes only an exactly matching trimmed first title", () => {
    const source = `  Phở Gà  \r
Broth with **ginger**.\r
\r
ingredients\r
•  chicken (whole)  \r
\r
steps\r
8) Simmer — gently.\r
\r
notes\r
\r
Keep **all** punctuation.\r
`;

    expect(parseRecipeMarkdown(source, " Phở Gà ")).toEqual({
      ok: true,
      sourceFormat: "example",
      value: {
        description: "Broth with **ginger**.",
        ingredients: ["chicken (whole)  "],
        steps: ["Simmer — gently."],
        notesMarkdown: "Keep **all** punctuation.",
      },
    });
    expect(parseRecipeMarkdown(source, "phở gà")).toMatchObject({
      ok: true,
      value: {
        description: "  Phở Gà  \nBroth with **ginger**.",
      },
    });
  });

  it("ignores blank list spacing while preserving every non-blank item value", () => {
    expect(
      parseRecipeMarkdown(
        `INGREDIENTS
• **2** onions

• 1 chicken
STEPS
4. Char (well).

9) Simmer at 90°C.
NOTES
`,
        "Recipe",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        ingredients: ["**2** onions", "1 chicken"],
        steps: ["Char (well).", "Simmer at 90°C."],
      },
    });
  });

  it("keeps task-like step text opaque in the demonstrated format", () => {
    expect(
      parseRecipeMarkdown(
        `INGREDIENTS
• broth
STEPS
1. [ ] Prepare broth.
2. [x] Strain broth.
NOTES
`,
        "Recipe",
      ),
    ).toMatchObject({
      ok: true,
      sourceFormat: "example",
      value: {
        steps: ["[ ] Prepare broth.", "[x] Strain broth."],
      },
    });
  });
  it("keeps indented continuation lines as part of their step", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- 2 shallots

## Steps

1. Start the aromatics
   Heat the oil over medium heat.
   Add shallots and sauté until softened.
2. Add the garlic
   Cook for about 1 minute.

## Notes
`,
        "Stew",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        steps: [
          "Start the aromatics\nHeat the oil over medium heat.\nAdd shallots and sauté until softened.",
          "Add the garlic\nCook for about 1 minute.",
        ],
      },
    });
  });

  it("preserves indentation relative to a step's shallowest continuation", () => {
    const parsed = parseRecipeMarkdown(
      `## Ingredients

- salt

## Steps

1. Season
     deeply indented
   shallower line

## Notes
`,
      "Seasoning",
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: { steps: ["Season\n  deeply indented\nshallower line"] },
    });
  });

  it("keeps a blank line inside a step and drops trailing blanks", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- salt

## Steps

1. Rest the dough

   Come back in an hour.

2. Bake

## Notes
`,
        "Dough",
      ),
    ).toMatchObject({
      ok: true,
      value: { steps: ["Rest the dough\n\nCome back in an hour.", "Bake"] },
    });
  });

  it("indents continuation lines under their own step marker", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredients: [],
        steps: ["Start\nThen this.", "Finish"],
        notesMarkdown: "",
      }),
    ).toBe(
      "## Ingredients\n\n## Steps\n\n1. Start\n   Then this.\n2. Finish\n\n## Notes\n",
    );
  });

  it("accepts a bullet character in the heading format", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

• 2 onions

## Steps

1. Season.

## Notes
`,
        "Recipe",
      ),
    ).toMatchObject({ ok: true, value: { ingredients: ["2 onions"] } });
  });

  it("round-trips a multi-line step", () => {
    const document = {
      description: "",
      ingredients: ["salt"],
      steps: ["Start the aromatics\nHeat the oil.\n\nWait.", "Serve"],
      notesMarkdown: "",
    };

    expect(
      parseRecipeMarkdown(serializeRecipeMarkdown(document), "Recipe"),
    ).toEqual({ ok: true, sourceFormat: "markdown", value: document });
  });

  it.each([
    {
      name: "missing marker",
      source: `INGREDIENTS
• chicken
STEPS
1. Simmer.
`,
      reason: "missing-section",
    },
    {
      name: "duplicate marker",
      source: `INGREDIENTS
• chicken
INGREDIENTS
• onion
STEPS
1. Simmer.
NOTES
`,
      reason: "duplicate-section",
    },
    {
      name: "reordered markers",
      source: `STEPS
1. Simmer.
INGREDIENTS
• chicken
NOTES
`,
      reason: "section-order",
    },
    {
      name: "mixed marker styles",
      source: `INGREDIENTS
• chicken
## Steps
1. Simmer.
## Notes
`,
      reason: "mixed-format",
    },
    {
      name: "mixed Markdown heading depths",
      source: `## Ingredients
- chicken
### Steps
1. Simmer.
## Notes
`,
      reason: "mixed-format",
    },
    {
      name: "non-list ingredient content",
      source: `INGREDIENTS
chicken
STEPS
1. Simmer.
NOTES
`,
      reason: "invalid-ingredient",
    },
    {
      name: "continued ingredient item",
      source: `## Ingredients
- chicken
  Keep this continuation.
## Steps
1. Simmer.
## Notes
`,
      reason: "unsupported-content",
    },
    {
      name: "content between ingredient rows",
      source: `INGREDIENTS
• chicken
Do not substitute.
• onion
STEPS
1. Simmer.
NOTES
`,
      reason: "unsupported-content",
    },
    {
      name: "malformed step",
      source: `INGREDIENTS
• chicken
STEPS
First, simmer.
NOTES
`,
      reason: "invalid-step",
    },
    {
      name: "task-list ingredient",
      source: `## Ingredients
- [ ] chicken
## Steps
1. Simmer.
## Notes
`,
      reason: "unsupported-content",
    },
    {
      name: "invalid step before unsupported ingredient content",
      source: `INGREDIENTS
• chicken
Keep this continuation.
STEPS
First, simmer.
NOTES
`,
      reason: "invalid-step",
    },
    {
      name: "unchecked ordered task-list step",
      source: `## Ingredients
- broth
## Steps
1. [ ] Prepare broth.
## Notes
`,
      reason: "unsupported-content",
    },
    {
      name: "checked ordered task-list step",
      source: `## Ingredients
- broth
## Steps
1. [x] Prepare broth.
## Notes
`,
      reason: "unsupported-content",
    },
    {
      name: "invalid ingredient with unsupported nested structure",
      source: `INGREDIENTS
chicken
  nested detail
STEPS
1. Simmer.
NOTES
`,
      reason: "invalid-ingredient",
    },
    {
      name: "invalid step with unsupported nested structure",
      source: `INGREDIENTS
• chicken
STEPS
First, simmer.
  nested detail
NOTES
`,
      reason: "invalid-step",
    },
  ] as const)(
    "rejects $name without mutating the source",
    ({ source, reason }) => {
      const originalSource = source;

      expect(parseRecipeMarkdown(source, "Recipe")).toEqual({
        ok: false,
        reason,
      });
      expect(source).toBe(originalSource);
    },
  );

  it("round-trips marker-shaped Markdown inside Notes as notes content", () => {
    const document = {
      description: "A marker-heavy recipe.",
      ingredients: ["broth"],
      steps: ["Simmer."],
      notesMarkdown: `INGREDIENTS
## Ingredients
STEPS
## Steps
NOTES
## Notes
Keep every marker-shaped line.`,
    };

    expect(
      parseRecipeMarkdown(serializeRecipeMarkdown(document), "Recipe"),
    ).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: document,
    });
  });

  it("round-trips standard Markdown through the canonical h2 format", () => {
    const parsed = parseRecipeMarkdown(markdown, "Recipe");
    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(
        parseRecipeMarkdown(serializeRecipeMarkdown(parsed.value), "Recipe"),
      ).toEqual({
        ok: true,
        sourceFormat: "markdown",
        value: parsed.value,
      });
    }
  });

  it.each(["", "   ", "\n\n", "\r\n \r\n"])(
    "reads a blank body (%j) as an empty recipe",
    (source) => {
      expect(parseRecipeMarkdown(source, "Untitled recipe")).toEqual({
        ok: true,
        sourceFormat: "markdown",
        value: {
          description: "",
          ingredients: [],
          steps: [],
          notesMarkdown: "",
        },
      });
    },
  );

  it("serialises a blank body into the scaffold the server writes", () => {
    const parsed = parseRecipeMarkdown("", "Untitled recipe");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeRecipeMarkdown(parsed.value)).toBe(
        "## Ingredients\n\n## Steps\n\n## Notes\n",
      );
    }
  });
});

describe("serializeRecipeMarkdown", () => {
  it("emits h2 sections with standard list markers", () => {
    const serialized = serializeRecipeMarkdown({
      description: "Clear broth. Makes four bowls.",
      ingredients: ["1 whole chicken", "2 onions"],
      steps: ["Char the onions.", "Simmer the chicken."],
      notesMarkdown: "**Batch-friendly**: Freeze the broth.",
    });

    expect(serialized).toBe(`Clear broth. Makes four bowls.

## Ingredients

- 1 whole chicken
- 2 onions

## Steps

1. Char the onions.
2. Simmer the chicken.

## Notes

**Batch-friendly**: Freeze the broth.
`);
    expect(serialized).not.toContain("•");
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("emits bare headings for sections that hold only empty rows", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredients: [" ", "\t"],
        steps: ["\t "],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n## Steps\n\n## Notes\n");
  });

  it("filters rows by trimmed emptiness without changing nonblank values", () => {
    const serialized = serializeRecipeMarkdown({
      description: "\r\n**Fast** broth.\r\n\r\nSecond paragraph.\r\n",
      ingredients: ["", " \t ", "**2** onions (sliced)  "],
      steps: ["\t", "Heat to 180°C — don't boil.  ", " ", "Serve."],
      notesMarkdown: "\r\nUse `fresh` herbs.\r\n",
    });

    expect(serialized).toBe(
      [
        "**Fast** broth.",
        "",
        "Second paragraph.",
        "",
        "## Ingredients",
        "",
        "- **2** onions (sliced)  ", // two trailing spaces, deliberate
        "",
        "## Steps",
        "",
        "1. Heat to 180°C — don't boil.  ", // two trailing spaces, deliberate
        "2. Serve.",
        "",
        "## Notes",
        "",
        "Use `fresh` herbs.",
        "",
      ].join("\n"),
    );
    expect(parseRecipeMarkdown(serialized, "Recipe")).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "**Fast** broth.\n\nSecond paragraph.",
        ingredients: ["**2** onions (sliced)  "],
        steps: ["Heat to 180°C — don't boil.  ", "Serve."],
        notesMarkdown: "Use `fresh` herbs.",
      },
    });
  });
});
