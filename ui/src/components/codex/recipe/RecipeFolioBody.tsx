import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import {
  Label,
  TextArea,
  TextField as AriaTextField,
} from "react-aria-components";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { Button } from "#/components/ui/button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { TextField } from "#/components/ui/text-field";
import type { RecipeDocument } from "#/recipe/recipeCodec";

export type RecipeFolioBodyProps = {
  document: RecipeDocument;
  mode: "read" | "edit";
  onModeChange: (mode: "read" | "edit") => void;
  onDocumentChange: (document: RecipeDocument) => void;
};

type RecipeCollectionKey = "ingredients" | "steps";
type PendingFocus = { collection: RecipeCollectionKey; index: number } | null;
const focusContainedAction = (
  container: HTMLSpanElement | null | undefined,
) => {
  const action = container?.firstElementChild;
  if (action instanceof HTMLElement) action.focus();
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
  const pendingFocus = useRef<PendingFocus>(null);
  const ingredientInputs = useRef<Array<HTMLInputElement | null>>([]);
  const stepInputs = useRef<Array<HTMLInputElement | null>>([]);
  const nextRowId = useRef(0);
  const ingredientRowIds = useRef<string[]>([]);
  const stepRowIds = useRef<string[]>([]);

  ingredientRowIds.current.length = Math.min(
    ingredientRowIds.current.length,
    document.ingredients.length,
  );
  while (ingredientRowIds.current.length < document.ingredients.length) {
    ingredientRowIds.current.push(`ingredient-${nextRowId.current++}`);
  }
  stepRowIds.current.length = Math.min(
    stepRowIds.current.length,
    document.steps.length,
  );
  while (stepRowIds.current.length < document.steps.length) {
    stepRowIds.current.push(`step-${nextRowId.current++}`);
  }

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const inputs =
      target.collection === "ingredients" ? ingredientInputs : stepInputs;
    const input = inputs.current[target.index];
    if (!input) return;
    input.focus();
    pendingFocus.current = null;
  }, [document.ingredients.length, document.steps.length]);

  const updateCollection = (
    collection: RecipeCollectionKey,
    values: string[],
  ) => {
    onDocumentChange({ ...document, [collection]: values });
  };

  const addRow = (collection: RecipeCollectionKey) => {
    const values = document[collection];
    const rowIds =
      collection === "ingredients" ? ingredientRowIds : stepRowIds;
    rowIds.current.push(`${collection}-${nextRowId.current++}`);
    pendingFocus.current = { collection, index: values.length };
    updateCollection(collection, [...values, ""]);
  };

  const moveRow = (
    collection: RecipeCollectionKey,
    index: number,
    destination: number,
  ) => {
    const values = [...document[collection]];
    const rowIds =
      collection === "ingredients" ? ingredientRowIds.current : stepRowIds.current;
    const movingValue = values[index];
    const displacedValue = values[destination];
    const movingRowId = rowIds[index];
    const displacedRowId = rowIds[destination];
    if (
      movingValue === undefined ||
      displacedValue === undefined ||
      movingRowId === undefined ||
      displacedRowId === undefined
    ) {
      return;
    }

    values[index] = displacedValue;
    values[destination] = movingValue;
    rowIds[index] = displacedRowId;
    rowIds[destination] = movingRowId;
    updateCollection(collection, values);
  };

  const removeRow = (collection: RecipeCollectionKey, index: number) => {
    const rowIds =
      collection === "ingredients" ? ingredientRowIds : stepRowIds;
    rowIds.current.splice(index, 1);
    updateCollection(
      collection,
      document[collection].filter((_, candidate) => candidate !== index),
    );
  };

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
            rows={4}
          />

          <RecipeCollectionEditor
            collection="ingredients"
            heading="Ingredients"
            headingId={ingredientsId}
            values={document.ingredients}
            inputRefs={ingredientInputs}
            rowIds={ingredientRowIds.current}
            onValueChange={(index, value) => {
              const ingredients = [...document.ingredients];
              ingredients[index] = value;
              updateCollection("ingredients", ingredients);
            }}
            onAdd={() => addRow("ingredients")}
            onMove={(index, destination) =>
              moveRow("ingredients", index, destination)
            }
            onRemove={(index) => removeRow("ingredients", index)}
          />

          <RecipeCollectionEditor
            collection="steps"
            heading="Steps"
            headingId={stepsId}
            values={document.steps}
            inputRefs={stepInputs}
            rowIds={stepRowIds.current}
            onValueChange={(index, value) => {
              const steps = [...document.steps];
              steps[index] = value;
              updateCollection("steps", steps);
            }}
            onAdd={() => addRow("steps")}
            onMove={(index, destination) =>
              moveRow("steps", index, destination)
            }
            onRemove={(index) => removeRow("steps", index)}
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

      <section
        aria-labelledby={notesId}
        className="border-t border-rule pt-5"
      >
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

function RecipeCollectionEditor({
  collection,
  heading,
  headingId,
  values,
  inputRefs,
  rowIds,
  onValueChange,
  onAdd,
  onMove,
  onRemove,
}: {
  collection: RecipeCollectionKey;
  heading: string;
  headingId: string;
  values: string[];
  rowIds: string[];
  inputRefs: React.RefObject<Array<HTMLInputElement | null>>;
  onValueChange: (index: number, value: string) => void;
  onAdd: () => void;
  onMove: (index: number, destination: number) => void;
  onRemove: (index: number) => void;
}) {
  const singular = collection === "ingredients" ? "ingredient" : "step";
  const label = collection === "ingredients" ? "Ingredient" : "Step";
  const moveUpActions = useRef<Array<HTMLSpanElement | null>>([]);
  const moveDownActions = useRef<Array<HTMLSpanElement | null>>([]);

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
        <h2
          id={headingId}
          className="cl-mono m-0 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-mute"
        >
          {heading}
        </h2>
        <Button variant="secondary" size="sm" onPress={onAdd}>
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add {singular}
        </Button>
      </div>

      <ol className="m-0 grid list-none gap-3 p-0">
        {values.map((value, index) => (
          <li
            key={rowIds[index]}
            className="grid gap-2 border-l-2 border-rule-soft pl-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          >
            <TextField
              label={`${label} ${index + 1}`}
              value={value}
              onChange={(next) => onValueChange(index, next)}
              inputRef={(input) => {
                inputRefs.current[index] = input;
              }}
              className="min-w-0"
            />
            <div className="flex items-center gap-1 sm:pb-px">
              <span
                ref={(container) => {
                  moveUpActions.current[index] = container;
                }}
                className="contents"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${singular} ${index + 1} up`}
                  isDisabled={index === 0}
                  onPress={() => {
                    if (index === 1) {
                      focusContainedAction(moveDownActions.current[index]);
                    }
                    onMove(index, index - 1);
                  }}
                >
                  <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </span>
              <span
                ref={(container) => {
                  moveDownActions.current[index] = container;
                }}
                className="contents"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${singular} ${index + 1} down`}
                  isDisabled={index === values.length - 1}
                  onPress={() => {
                    if (index === values.length - 2) {
                      focusContainedAction(moveUpActions.current[index]);
                    }
                    onMove(index, index + 1);
                  }}
                >
                  <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${singular} ${index + 1}`}
                onPress={() => onRemove(index)}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function RecipeTextArea({
  label,
  value,
  onChange,
  rows,
  hideLabel = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  hideLabel?: boolean;
}) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
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
        className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 font-sans text-sm leading-relaxed text-ink outline-none data-[focused]:border-ring data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[focus-visible]:outline-offset-2"
      />
    </AriaTextField>
  );
}
