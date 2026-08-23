import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  TextField as AriaTextField,
  Label,
  TextArea,
} from "react-aria-components";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { Button } from "#/components/ui/button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { TextField } from "#/components/ui/text-field";
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
      <div className="mb-5 flex justify-end border-b border-rule-soft pb-3">
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
            placeholder="what the dish is, yield, timing"
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
            itemPlaceholder="what to do first"
            rows={10}
            groups={document.stepGroups}
            toText={textFromSteps}
            fromText={stepsFromText}
            onGroupsChange={(stepGroups) =>
              onDocumentChange({ ...document, stepGroups })
            }
          />

          <section aria-labelledby={notesId} className="grid gap-3">
            <h2
              id={notesId}
              className="cl-mono m-0 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
            >
              Notes
            </h2>
            <RecipeTextArea
              label="Notes"
              hideLabel
              value={document.notesMarkdown}
              onChange={(notesMarkdown) =>
                onDocumentChange({ ...document, notesMarkdown })
              }
              placeholder="substitutions, make-ahead, storage"
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

function RecipeReadGroup({
  name,
  children,
}: {
  name: string | null;
  children: React.ReactNode;
}) {
  return (
    <>
      {name === null ? null : (
        <h3 className="cl-mono m-0 pt-4 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-mute">
          {name}
        </h3>
      )}
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
  return (
    <div className="grid gap-8">
      {document.description ? (
        <section aria-label="Description" className="text-ink-2">
          <MarkdownRenderer content={document.description} />
        </section>
      ) : null}

      <div className="grid gap-8 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-12">
        <section aria-labelledby={ingredientsId}>
          <h2
            id={ingredientsId}
            className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
          >
            Ingredients
          </h2>
          {visibleGroups(document.ingredientGroups).map((group, index) => (
            <RecipeReadGroup
              key={`${index}:${group.name ?? ""}`}
              name={group.name}
            >
              <ul className="m-0 list-disc space-y-2 py-4 pl-5 marker:text-accent">
                {group.items.map((item, itemIndex) => (
                  <li key={`${itemIndex}:${item}`} className="pl-1 text-ink-2">
                    {item}
                  </li>
                ))}
              </ul>
            </RecipeReadGroup>
          ))}
        </section>

        <section aria-labelledby={stepsId}>
          <h2
            id={stepsId}
            className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
          >
            Steps
          </h2>
          {visibleGroups(document.stepGroups).map((group, index) => (
            <RecipeReadGroup
              key={`${index}:${group.name ?? ""}`}
              name={group.name}
            >
              <ol className="m-0 list-decimal space-y-4 py-4 pl-7 marker:font-heading marker:text-base marker:font-bold marker:text-accent">
                {group.items.map((item, itemIndex) => (
                  <li
                    key={`${itemIndex}:${item}`}
                    className="whitespace-pre-line pl-2 text-ink-2"
                  >
                    {item}
                  </li>
                ))}
              </ol>
            </RecipeReadGroup>
          ))}
        </section>
      </div>

      <section aria-labelledby={notesId} className="border-t border-rule pt-5">
        <h2
          id={notesId}
          className="cl-mono m-0 mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
        >
          Notes
        </h2>
        <MarkdownRenderer content={document.notesMarkdown} />
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
      <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
        <h2
          id={headingId}
          className="cl-mono m-0 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
        >
          {heading}
        </h2>
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
            className="grid gap-2 border-l-2 border-rule-soft pl-3"
          >
            <div className="flex items-end justify-between gap-2">
              <TextField
                label={`${groupLabel} group ${index} name`}
                value={group.name ?? ""}
                onChange={(name) => replace(index, { name })}
                placeholder="for the sauce"
                className="min-w-0 flex-1"
              />
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
  label,
  items,
  placeholder,
  rows,
  toText,
  fromText,
  onItemsChange,
}: {
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
  label,
  value,
  onChange,
  onBlur,
  rows,
  placeholder,
  hideLabel = false,
}: {
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
      <Label
        className={
          hideLabel
            ? "sr-only"
            : "cl-mono text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
        }
      >
        {label}
      </Label>
      <TextArea
        rows={rows}
        placeholder={placeholder}
        className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 font-sans text-sm leading-relaxed text-ink outline-none data-[focused]:border-ring data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[focus-visible]:outline-offset-2"
      />
    </AriaTextField>
  );
}
