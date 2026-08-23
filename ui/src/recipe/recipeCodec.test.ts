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
        ingredientGroups: [
          { name: null, items: ["1 whole chicken", "2 onions"] },
        ],
        stepGroups: [
          { name: null, items: ["Char the onions.", "Simmer the chicken."] },
        ],
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
        ingredientGroups: [
          { name: null, items: ["chicken", "onion", "garlic"] },
        ],
        stepGroups: [{ name: null, items: ["Simmer.", "Serve."] }],
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
        ingredientGroups: [{ name: null, items: [] }],
        stepGroups: [{ name: null, items: [] }],
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
        ingredientGroups: [{ name: null, items: ["chicken (whole)  "] }],
        stepGroups: [{ name: null, items: ["Simmer — gently."] }],
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
        ingredientGroups: [
          { name: null, items: ["**2** onions", "1 chicken"] },
        ],
        stepGroups: [
          { name: null, items: ["Char (well).", "Simmer at 90°C."] },
        ],
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
        stepGroups: [
          { name: null, items: ["[ ] Prepare broth.", "[x] Strain broth."] },
        ],
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
        stepGroups: [
          {
            name: null,
            items: [
              "Start the aromatics\nHeat the oil over medium heat.\nAdd shallots and sauté until softened.",
              "Add the garlic\nCook for about 1 minute.",
            ],
          },
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
      value: {
        stepGroups: [
          { name: null, items: ["Season\n  deeply indented\nshallower line"] },
        ],
      },
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
      value: {
        stepGroups: [
          {
            name: null,
            items: ["Rest the dough\n\nCome back in an hour.", "Bake"],
          },
        ],
      },
    });
  });

  it("indents continuation lines under their own step marker", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [{ name: null, items: [] }],
        stepGroups: [{ name: null, items: ["Start\nThen this.", "Finish"] }],
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
    ).toMatchObject({
      ok: true,
      value: { ingredientGroups: [{ name: null, items: ["2 onions"] }] },
    });
  });

  it("round-trips a multi-line step", () => {
    const document = {
      description: "",
      ingredientGroups: [{ name: null, items: ["salt"] }],
      stepGroups: [
        {
          name: null,
          items: ["Start the aromatics\nHeat the oil.\n\nWait.", "Serve"],
        },
      ],
      notesMarkdown: "",
    };

    expect(
      parseRecipeMarkdown(serializeRecipeMarkdown(document), "Recipe"),
    ).toEqual({ ok: true, sourceFormat: "markdown", value: document });
  });

  it("reads h3 headings as component groups", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- 200g flour

### For the sauce

- 2 tomatoes
- 1 clove garlic

## Steps

1. Make the dough.

### For the sauce

1. Blanch the tomatoes.
2. Blend.

## Notes
`,
        "Pizza",
      ),
    ).toEqual({
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "",
        ingredientGroups: [
          { name: null, items: ["200g flour"] },
          { name: "For the sauce", items: ["2 tomatoes", "1 clove garlic"] },
        ],
        stepGroups: [
          { name: null, items: ["Make the dough."] },
          { name: "For the sauce", items: ["Blanch the tomatoes.", "Blend."] },
        ],
        notesMarkdown: "",
      },
    });
  });

  it("restarts step numbering in each group", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [{ name: null, items: [] }],
        stepGroups: [
          { name: null, items: ["Make the dough.", "Rest it."] },
          { name: "For the sauce", items: ["Blanch.", "Blend."] },
        ],
        notesMarkdown: "",
      }),
    ).toBe(
      "## Ingredients\n\n## Steps\n\n1. Make the dough.\n2. Rest it.\n\n### For the sauce\n\n1. Blanch.\n2. Blend.\n\n## Notes\n",
    );
  });

  it("emits a named group that holds no items", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [
          { name: null, items: [] },
          { name: "For the sauce", items: [] },
        ],
        stepGroups: [{ name: null, items: [] }],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n### For the sauce\n\n## Steps\n\n## Notes\n");
  });

  it("merges a group whose name is blank into the group before it", () => {
    expect(
      serializeRecipeMarkdown({
        description: "",
        ingredientGroups: [
          { name: null, items: ["flour"] },
          { name: "   ", items: ["salt"] },
        ],
        stepGroups: [{ name: null, items: [] }],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n- flour\n- salt\n\n## Steps\n\n## Notes\n");
  });

  it("treats a section name at group depth as a group, not a section", () => {
    expect(
      parseRecipeMarkdown(
        `## Ingredients

- salt

## Steps

1. Season.

### Notes

1. Rest before serving.

## Notes

Keep this.
`,
        "Seasoning",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        stepGroups: [
          { name: null, items: ["Season."] },
          { name: "Notes", items: ["Rest before serving."] },
        ],
        notesMarkdown: "Keep this.",
      },
    });
  });

  it.each([
    {
      name: "group heading at the wrong depth",
      source: `## Ingredients

- salt

#### For the sauce

- 2 tomatoes

## Steps

1. Season.

## Notes
`,
    },
    {
      name: "group heading with no name",
      source: `## Ingredients

- salt

###

- 2 tomatoes

## Steps

1. Season.

## Notes
`,
    },
    {
      name: "group heading in the legacy marker format",
      source: `INGREDIENTS
• salt
### For the sauce
• 2 tomatoes
STEPS
1. Season.
NOTES
`,
    },
  ] as const)("rejects a $name", ({ source }) => {
    expect(parseRecipeMarkdown(source, "Recipe")).toEqual({
      ok: false,
      reason: "unsupported-content",
    });
  });

  it.each([
    {
      name: "legacy bare markers",
      title: "Masoor Dal with Tadka-on-Demand",
      source: `A North Indian masoor dal.

INGREDIENTS
• 300 grams red split lentils, rinsed
• 1.5 liters water

STEPS
1. Start the lentils: put them in a heavy pot.
2. Build the base: heat the ghee.

NOTES
**Batch-friendly**: improves over three days.
`,
    },
    {
      name: "legacy markers under a duplicated title line",
      title: "Phở Gà (Hanoi-style Chicken Pho)",
      source: `Phở Gà (Hanoi-style Chicken Pho)
Clean, clear chicken broth.

INGREDIENTS
• 1.5 kilograms whole chicken

STEPS

1. Char the aromatics until blackened in patches.

NOTES
`,
    },
    {
      name: "headings with asterisk bullets and multi-line steps",
      title: "Double Black Bean Stew",
      source: `## Ingredients

* 1 tbsp neutral oil
* 2 shallots, finely sliced

## Steps

1. Start the aromatics
   Heat the oil in a wide frying pan over medium heat.
   Add shallots and sauté until softened.
2. Add the garlic
   Cook for about 1 minute.

## Notes

* Rinsing the beans keeps the salinity under control.
`,
    },
  ] as const)(
    "reads $name and is stable across a second round-trip",
    ({ title, source }) => {
      const parsed = parseRecipeMarkdown(source, title);
      expect(parsed).toMatchObject({ ok: true });
      if (!parsed.ok) return;

      const canonical = serializeRecipeMarkdown(parsed.value);
      expect(canonical).toContain("## Ingredients");
      expect(canonical).not.toContain("• ");
      expect(parseRecipeMarkdown(canonical, title)).toEqual({
        ok: true,
        sourceFormat: "markdown",
        value: parsed.value,
      });
    },
  );

  it("round-trips a grouped recipe", () => {
    const document = {
      description: "A composed dish.",
      ingredientGroups: [
        { name: null, items: ["200g flour"] },
        { name: "For the sauce", items: ["2 tomatoes"] },
      ],
      stepGroups: [
        { name: null, items: ["Make the dough.\nRest it."] },
        { name: "For the sauce", items: ["Blend."] },
      ],
      notesMarkdown: "Freezes well.",
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
      ingredientGroups: [{ name: null, items: ["broth"] }],
      stepGroups: [{ name: null, items: ["Simmer."] }],
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
          ingredientGroups: [{ name: null, items: [] }],
          stepGroups: [{ name: null, items: [] }],
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
      ingredientGroups: [
        { name: null, items: ["1 whole chicken", "2 onions"] },
      ],
      stepGroups: [
        { name: null, items: ["Char the onions.", "Simmer the chicken."] },
      ],
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
        ingredientGroups: [{ name: null, items: [" ", "\t"] }],
        stepGroups: [{ name: null, items: ["\t "] }],
        notesMarkdown: "",
      }),
    ).toBe("## Ingredients\n\n## Steps\n\n## Notes\n");
  });

  it("filters rows by trimmed emptiness without changing nonblank values", () => {
    const serialized = serializeRecipeMarkdown({
      description: "\r\n**Fast** broth.\r\n\r\nSecond paragraph.\r\n",
      ingredientGroups: [
        { name: null, items: ["", " \t ", "**2** onions (sliced)  "] },
      ],
      stepGroups: [
        {
          name: null,
          items: ["\t", "Heat to 180°C — don't boil.  ", " ", "Serve."],
        },
      ],
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
        ingredientGroups: [{ name: null, items: ["**2** onions (sliced)  "] }],
        stepGroups: [
          { name: null, items: ["Heat to 180°C — don't boil.  ", "Serve."] },
        ],
        notesMarkdown: "Use `fresh` herbs.",
      },
    });
  });
});
