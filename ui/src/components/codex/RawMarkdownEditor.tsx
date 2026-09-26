import { useId } from "react";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export interface RawMarkdownEditorProps {
  value: string;
  diagnostic?: string | null;
  onChange: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
}

export function RawMarkdownEditor({
  value,
  diagnostic,
  onChange,
  onApply,
  onCancel,
}: RawMarkdownEditorProps) {
  const textareaId = useId();
  const diagnosticId = useId();

  return (
    <section aria-label="Raw Markdown editor" className="mt-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2.5">
          <Tick />
          <label
            htmlFor={textareaId}
            className="font-serif text-[20px] leading-none text-ink italic"
          >
            Raw Markdown
          </label>
        </span>
        <p className="m-0 text-[13px] text-mute">
          Edits stay local until Apply.
        </p>
      </div>
      <textarea
        id={textareaId}
        data-code-editor=""
        aria-describedby={diagnostic ? diagnosticId : undefined}
        className={cn(
          "min-h-[18rem] w-full shrink-0 resize-y rounded-xl bg-sink p-4 text-[13.5px] leading-6 text-ink sm:min-h-[24rem]",
          FOCUS_RING_NATIVE,
        )}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        spellCheck={false}
      />
      {diagnostic ? (
        <p
          id={diagnosticId}
          role="alert"
          className="mt-2 mb-0 text-[13.5px] text-hot"
        >
          {diagnostic}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onPress={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onPress={onApply}>
          Apply
        </Button>
      </div>
    </section>
  );
}
