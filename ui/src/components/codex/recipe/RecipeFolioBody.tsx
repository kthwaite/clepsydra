import { useId, useState } from "react";
import {
  TextField as AriaTextField,
  Label,
  TextArea,
} from "react-aria-components";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { itemsFromText, textFromItems } from "#/recipe/recipeText";
import type { RecipeDocument } from "#/recipe/recipeCodec";

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

          <section aria-labelledby={ingredientsId} className="grid gap-3">
            <h2
              id={ingredientsId}
              className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
            >
              Ingredients
            </h2>
            <RecipeItemsTextArea
              label="Ingredients"
              items={document.ingredients}
              placeholder="200g flour"
              rows={8}
              onItemsChange={(ingredients) =>
                onDocumentChange({ ...document, ingredients })
              }
            />
          </section>

          <section aria-labelledby={stepsId} className="grid gap-3">
            <h2
              id={stepsId}
              className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
            >
              Steps
            </h2>
            <RecipeItemsTextArea
              label="Steps"
              items={document.steps}
              placeholder="what to do first"
              rows={10}
              onItemsChange={(steps) => onDocumentChange({ ...document, steps })}
            />
          </section>

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
          <ul className="m-0 list-disc space-y-2 py-4 pl-5 marker:text-accent">
            {document.ingredients.map((ingredient, index) => (
              <li key={`${index}:${ingredient}`} className="pl-1 text-ink-2">
                {ingredient}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby={stepsId}>
          <h2
            id={stepsId}
            className="cl-mono m-0 border-b border-rule pb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
          >
            Steps
          </h2>
          <ol className="m-0 list-decimal space-y-4 py-4 pl-7 marker:font-heading marker:text-base marker:font-bold marker:text-accent">
            {document.steps.map((step, index) => (
              <li key={`${index}:${step}`} className="pl-2 text-ink-2">
                {step}
              </li>
            ))}
          </ol>
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

/** A textarea whose value is the document's canonical text, except while the
 * reader is mid-edit. Re-deriving the value on every keystroke would move the
 * caret whenever normalisation changed the text, so the local draft governs
 * until focus leaves. */
function RecipeItemsTextArea({
  label,
  items,
  placeholder,
  rows,
  onItemsChange,
}: {
  label: string;
  items: string[];
  placeholder: string;
  rows: number;
  onItemsChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <RecipeTextArea
      label={label}
      hideLabel
      value={draft ?? textFromItems(items)}
      placeholder={placeholder}
      rows={rows}
      onChange={(value) => {
        setDraft(value);
        onItemsChange(itemsFromText(value));
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
