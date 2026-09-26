import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  TextField as AriaTextField,
  Input,
  Label,
  TextArea,
} from "react-aria-components";
import { Tick } from "#/components/codex/Tick";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { Button } from "#/components/ui/button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import type { RecipeDocument, RecipeGroup } from "#/recipe/recipeCodec";
import {
  itemsFromText,
  stepsFromText,
  textFromItems,
  textFromSteps,
} from "#/recipe/recipeText";

export type RecipeFolioBodyProps = {
  document: RecipeDocument;
  mode: "read" | "edit";
  onModeChange: (mode: "read" | "edit") => void;
  onDocumentChange: (document: RecipeDocument) => void;
};

/** Section eyebrow (spec §5.4): italic serif, muted, after a tick. */
const EYEBROW =
  "m-0 font-serif text-[22px] leading-none font-normal text-mute italic";

/** A component group's name ("For the sauce"). */
const GROUP_HEADING =
  "m-0 mt-3.5 mb-2 font-serif text-[18px] font-normal text-ink-2 italic";

function Eyebrow({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <h2 id={id} className={cn("flex items-center gap-2.5", className)}>
      <Tick />
      <span className={EYEBROW}>{children}</span>
    </h2>
  );
}

const recipeModeOptions = [
  { id: "read", label: "Read" },
  { id: "edit", label: "Edit" },
] as const;

export function RecipeFolioBody({
  document,
  mode,
  onModeChange,
  onDocumentChange,
}: RecipeFolioBodyProps) {
  const ingredientsId = useId();
  const stepsId = useId();
  const notesId = useId();

  return (
    <div className="recipe-folio-body" data-folio-heading-root>
      <div className="mb-6 flex justify-end">
        <SegmentedControl
          label="Recipe mode"
          value={mode}
          options={recipeModeOptions}
          onChange={(value) => onModeChange(value as "read" | "edit")}
          className="items-end"
        />
      </div>

      {mode === "read" ? (
        <RecipeReadView
          document={document}
          ingredientsId={ingredientsId}
          stepsId={stepsId}
          notesId={notesId}
        />
      ) : (
        <div className="grid gap-7">
          <RecipeTextArea
            label="Description"
            value={document.description}
            onChange={(description) =>
              onDocumentChange({ ...document, description })
            }
            placeholder="What the dish is, yield, timing"
            rows={4}
          />

          <RecipeGroupsEditor
            heading="Ingredients"
            headingId={ingredientsId}
            singular="ingredient"
            groupLabel="Ingredient"
            itemPlaceholder="200g flour"
            rows={8}
            groups={document.ingredientGroups}
            toText={textFromItems}
            fromText={itemsFromText}
            onGroupsChange={(ingredientGroups) =>
              onDocumentChange({ ...document, ingredientGroups })
            }
          />

          <RecipeGroupsEditor
            heading="Steps"
            headingId={stepsId}
            singular="step"
            groupLabel="Step"
            itemPlaceholder="What to do first"
            rows={10}
            groups={document.stepGroups}
            toText={textFromSteps}
            fromText={stepsFromText}
            onGroupsChange={(stepGroups) =>
              onDocumentChange({ ...document, stepGroups })
            }
          />

          <section aria-labelledby={notesId} className="grid gap-3">
            <Eyebrow id={notesId}>Notes</Eyebrow>
            <RecipeTextArea
              label="Notes"
              hideLabel
              value={document.notesMarkdown}
              onChange={(notesMarkdown) =>
                onDocumentChange({ ...document, notesMarkdown })
              }
              placeholder="Substitutions, make-ahead, storage"
              rows={7}
            />
          </section>
        </div>
      )}
    </div>
  );
}

/** The unnamed lead group is structural, not visible: hide it when it holds
 * nothing, so a fully grouped recipe shows no stray empty list. Named groups
 * always render — the heading tells the reader the component exists. */
const visibleGroups = (groups: RecipeGroup[]): RecipeGroup[] =>
  groups.filter((group, index) => index > 0 || group.items.length > 0);

function withOccurrenceKeys<T>(
  values: T[],
  identity: (value: T) => string,
): Array<{ key: string; value: T }> {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = identity(value);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}\u0000${occurrence}`, value };
  });
}

const recipeGroupIdentity = (group: RecipeGroup) =>
  JSON.stringify([group.name, group.items]);

function RecipeReadGroup({
  name,
  children,
}: {
  name: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      {name === null ? null : <h3 className={GROUP_HEADING}>{name}</h3>}
      {children}
    </>
  );
}

function RecipeReadView({
  document,
  ingredientsId,
  stepsId,
  notesId,
}: {
  document: RecipeDocument;
  ingredientsId: string;
  stepsId: string;
  notesId: string;
}) {
  // Steps number straight through the groups: "Bake" picks up where "Dough"
  // left off, so step 3 is the third thing to do.
  const stepGroups = visibleGroups(document.stepGroups);
  const stepStarts: number[] = [];
  let next = 1;
  for (const group of stepGroups) {
    stepStarts.push(next);
    next += group.items.length;
  }

  return (
    <div className="grid gap-8">
      {document.description ? (
        <section
          aria-label="Description"
          className="text-[17px] leading-[1.7] text-ink-2"
        >
          <MarkdownRenderer content={document.description} />
        </section>
      ) : null}

      <div className="grid gap-8 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-12">
        <section aria-labelledby={ingredientsId}>
          <Eyebrow id={ingredientsId}>Ingredients</Eyebrow>
          <div className="pl-[17px]">
            {withOccurrenceKeys(
              visibleGroups(document.ingredientGroups),
              recipeGroupIdentity,
            ).map(({ key: groupKey, value: group }) => (
              <RecipeReadGroup key={groupKey} name={group.name}>
                <ul className="m-0 flex list-none flex-col gap-[9px] p-0 pt-3.5 text-[16px] leading-normal text-ink-2 [h3+&]:pt-0">
                  {withOccurrenceKeys(group.items, (item) => item).map(
                    ({ key: itemKey, value: item }) => (
                      <li key={itemKey} className="flex items-baseline gap-3">
                        <span
                          aria-hidden
                          className="h-[5px] w-[5px] shrink-0 -translate-y-[3px] rounded-full bg-accent"
                        />
                        <span className="min-w-0">{item}</span>
                      </li>
                    ),
                  )}
                </ul>
              </RecipeReadGroup>
            ))}
          </div>
        </section>

        <section aria-labelledby={stepsId}>
          <Eyebrow id={stepsId}>Steps</Eyebrow>
          <div className="pl-[17px]">
            {withOccurrenceKeys(stepGroups, recipeGroupIdentity).map(
              ({ key: groupKey, value: group }, groupIndex) => {
                const start = stepStarts[groupIndex] ?? 1;
                return (
                  <RecipeReadGroup key={groupKey} name={group.name}>
                    <ol
                      start={start}
                      className="m-0 flex list-none flex-col gap-2.5 p-0 pt-3.5 text-[16px] leading-[1.55] text-ink-2 [h3+&]:pt-0"
                    >
                      {withOccurrenceKeys(group.items, (item) => item).map(
                        ({ key: itemKey, value: item }, itemIndex) => (
                          <li
                            key={itemKey}
                            className="grid grid-cols-[26px_minmax(0,1fr)] items-baseline gap-2.5"
                          >
                            <span
                              aria-hidden
                              className="font-serif text-[24px] leading-none text-accent"
                            >
                              {start + itemIndex}
                            </span>
                            <span className="whitespace-pre-line">{item}</span>
                          </li>
                        ),
                      )}
                    </ol>
                  </RecipeReadGroup>
                );
              },
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby={notesId}>
        <Eyebrow id={notesId} className="mb-3">
          Notes
        </Eyebrow>
        <div className="pl-[17px] text-ink-2">
          <MarkdownRenderer content={document.notesMarkdown} />
        </div>
      </section>
    </div>
  );
}

/** One whole collection — the lead textarea, every named group, and Add group.
 * It owns its group operations, so the parent passes only `groups` and
 * `onGroupsChange`. */
function RecipeGroupsEditor({
  heading,
  headingId,
  singular,
  groupLabel,
  itemPlaceholder,
  rows,
  groups,
  toText,
  fromText,
  onGroupsChange,
}: {
  heading: string;
  headingId: string;
  /** Lowercase, for button copy: "Add ingredient group". */
  singular: "ingredient" | "step";
  /** Capitalised, for field labels: "Ingredient group 1 name". */
  groupLabel: "Ingredient" | "Step";
  itemPlaceholder: string;
  rows: number;
  groups: RecipeGroup[];
  toText: (items: string[]) => string;
  fromText: (text: string) => string[];
  onGroupsChange: (groups: RecipeGroup[]) => void;
}) {
  const [lead, ...named] = groups;

  const replace = (index: number, patch: Partial<RecipeGroup>) =>
    onGroupsChange(
      groups.map((group, candidate) =>
        candidate === index ? { ...group, ...patch } : group,
      ),
    );

  /** Removing a group keeps its items: they join the group above, so a misclick
   * never destroys written text. */
  const removeGroup = (index: number) => {
    const next = groups.map((group) => ({ ...group }));
    const [removed] = next.splice(index, 1);
    const target = next[index - 1];
    if (removed && target) target.items = [...target.items, ...removed.items];
    onGroupsChange(next);
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow id={headingId}>{heading}</Eyebrow>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onGroupsChange([...groups, { name: "", items: [] }])}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add {singular} group
        </Button>
      </div>

      <RecipeItemsTextArea
        label={heading}
        items={lead?.items ?? []}
        placeholder={itemPlaceholder}
        rows={rows}
        toText={toText}
        fromText={fromText}
        onItemsChange={(items) => replace(0, { items })}
      />

      {named.map((group, offset) => {
        const index = offset + 1;
        return (
          <div
            key={`${singular}-group-${index}`}
            className="grid gap-2 rounded-2xl bg-sink p-3"
          >
            <div className="flex items-end justify-between gap-2">
              <AriaTextField
                value={group.name ?? ""}
                onChange={(name) => replace(index, { name })}
                className="flex min-w-0 flex-1 flex-col"
              >
                <Label className="text-[12.5px] text-mute">
                  {`${groupLabel} group ${index} name`}
                </Label>
                <Input
                  placeholder="For the sauce"
                  className={cn(
                    "mt-1.5 h-10 w-full rounded-full bg-raise px-4 font-serif text-[18px] text-ink italic placeholder:text-mute",
                    FOCUS_RING,
                  )}
                />
              </AriaTextField>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${singular} group ${index}`}
                onPress={() => removeGroup(index)}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
            <RecipeItemsTextArea
              inset
              label={`${groupLabel} group ${index} items`}
              items={group.items}
              placeholder={itemPlaceholder}
              rows={rows}
              toText={toText}
              fromText={fromText}
              onItemsChange={(items) => replace(index, { items })}
            />
          </div>
        );
      })}
    </section>
  );
}

/** A textarea whose value is the document's canonical text, except while the
 * reader is mid-edit. Re-deriving the value on every keystroke would move the
 * caret whenever normalisation changed the text, so the local draft governs
 * until focus leaves. */
function RecipeItemsTextArea({
  inset = false,
  label,
  items,
  placeholder,
  rows,
  toText,
  fromText,
  onItemsChange,
}: {
  /** Sits inside a sink group panel, so the field raises instead. */
  inset?: boolean;
  label: string;
  items: string[];
  placeholder: string;
  rows: number;
  toText: (items: string[]) => string;
  fromText: (text: string) => string[];
  onItemsChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <RecipeTextArea
      inset={inset}
      label={label}
      hideLabel
      value={draft ?? toText(items)}
      placeholder={placeholder}
      rows={rows}
      onChange={(value) => {
        setDraft(value);
        onItemsChange(fromText(value));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

function RecipeTextArea({
  inset = false,
  label,
  value,
  onChange,
  onBlur,
  rows,
  placeholder,
  hideLabel = false,
}: {
  inset?: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  rows: number;
  placeholder?: string;
  hideLabel?: boolean;
}) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      className="group flex min-w-0 flex-col"
    >
      {hideLabel ? (
        <Label className="sr-only">{label}</Label>
      ) : (
        <Label className="flex items-center gap-2.5">
          <Tick />
          <span className={EYEBROW}>{label}</span>
        </Label>
      )}
      <TextArea
        rows={rows}
        placeholder={placeholder}
        className={cn(
          "mt-3 w-full shrink-0 resize-y rounded-xl px-4 py-3 text-[15px] leading-relaxed text-ink placeholder:text-mute",
          inset ? "bg-raise" : "bg-sink",
          FOCUS_RING,
        )}
      />
    </AriaTextField>
  );
}
