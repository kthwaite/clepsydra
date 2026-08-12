import { useId } from "react";
import { Button } from "#/components/ui/button";

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
    <section
      aria-label="Raw Markdown editor"
      className="mt-5 border border-rule bg-background p-3 sm:p-4"
    >
      <div className="mb-2">
        <label
          htmlFor={textareaId}
          className="cl-mono block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink"
        >
          Raw Markdown
        </label>
        <p className="cl-marg mt-1 mb-0 text-xs text-ink-mute">
          Edits stay local until Apply.
        </p>
      </div>
      <textarea
        id={textareaId}
        aria-describedby={diagnostic ? diagnosticId : undefined}
        className="min-h-[18rem] w-full resize-y border border-rule bg-background p-3 font-mono text-sm leading-6 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:min-h-[24rem]"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        spellCheck={false}
      />
      {diagnostic ? (
        <p
          id={diagnosticId}
          role="alert"
          className="mt-2 mb-0 text-sm text-destructive"
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
