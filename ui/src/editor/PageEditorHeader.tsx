import { FileCode } from "lucide-react";
import { useState } from "react";
import { Button, TooltipTrigger } from "react-aria-components";
import { TagInput } from "#/components/ui/tag-input";
import { VesselTooltip } from "#/components/ui/tooltip";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  tagSuggestions: string[];
  onTagSuggestionQueryChange?: (query: string) => void;
  tagSuggestionsLoading?: boolean;
  tagSuggestionsError?: Error | null;
  onRetryTagSuggestions?: () => void;
  derivedTags?: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
  /** Flush a save immediately — wired to title/tag blur. */
  onSaveNow?: () => void | Promise<void>;
  /** When set, the title renders as this static text and cannot be edited
   *  (JOURNAL pages: the formatted day label). */
  readOnlyTitle?: string;
  encrypted?: boolean;
  onRequestLock?: () => Promise<boolean>;
  /** When set, renders a "Raw Markdown" icon button beside the title. */
  onOpenRawMarkdown?: () => void;
}

/** Last path segment, e.g. "notes/ideas/my-note.md" → "my-note.md". */
function filename(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * The Raw Markdown toggle: a quiet mono icon button with a Vessel tooltip.
 * Shared by `PageEditorHeader` and Folio's `ReadOnlyPageHeader`.
 */
export function RawMarkdownButton({ onPress }: { onPress: () => void }) {
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <Button
        aria-label="Raw Markdown"
        onPress={onPress}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center border border-transparent bg-transparent text-ink-mute outline-none transition-colors data-[hovered]:text-accent data-[focus-visible]:text-accent data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent max-md:h-11 max-md:w-11"
      >
        <FileCode size={14} />
      </Button>
      <VesselTooltip>Raw Markdown</VesselTooltip>
    </TooltipTrigger>
  );
}

export function PageEditorHeader({
  path,
  title,
  onTitleChange,
  tags,
  tagSuggestions,
  onTagSuggestionQueryChange,
  tagSuggestionsLoading = false,
  tagSuggestionsError = null,
  onRetryTagSuggestions,
  derivedTags = [],
  onTagsChange,
  aliases,
  onAliasesChange,
  onSaveNow,
  readOnlyTitle,
  encrypted = false,
  onRequestLock,
  onOpenRawMarkdown,
}: PageEditorHeaderProps) {
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  const requestLock = async () => {
    if (!onRequestLock || locking) return;
    setLocking(true);
    setLockError(null);
    try {
      const locked = await onRequestLock();
      if (!locked) {
        setLockError("Unable to lock while an editor has unsaved changes.");
      }
    } catch {
      setLockError("Unable to lock while an editor has unsaved changes.");
    } finally {
      setLocking(false);
    }
  };
  const flush = () => {
    void Promise.resolve(onSaveNow?.()).catch(() => undefined);
  };

  return (
    <div className="pb-4 max-md:flex max-md:flex-col max-md:gap-3">
      {encrypted && onRequestLock ? (
        <div className="mb-2 flex items-center justify-end gap-2 max-md:mb-0 max-md:min-h-11 max-md:w-full max-md:justify-between">
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            encrypted
          </span>
          <button
            type="button"
            className="cl-btn max-md:min-h-11"
            disabled={locking}
            onClick={() => void requestLock()}
            aria-label="Lock encrypted notes"
          >
            {locking ? "locking…" : "lock"}
          </button>
        </div>
      ) : null}
      {lockError ? (
        <p role="alert" className="cl-mono mb-2 text-[10px] text-hot">
          ⁂ {lockError}
        </p>
      ) : null}
      <div className="flex items-start gap-2">
        {readOnlyTitle !== undefined ? (
          <h1 className="min-w-0 w-full flex-1 font-heading text-2xl font-bold">
            {readOnlyTitle}
          </h1>
        ) : (
          <textarea
            rows={1}
            aria-label="Page title"
            value={title}
            onChange={(event) =>
              onTitleChange(event.currentTarget.value.replace(/[\r\n]/g, ""))
            }
            onBlur={flush}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
              }
            }}
            placeholder={filename(path)}
            className="field-sizing-content block min-w-0 w-full max-w-full flex-1 resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground max-md:min-h-11 md:field-sizing-fixed md:whitespace-nowrap md:break-normal md:overflow-x-auto"
          />
        )}
        {onOpenRawMarkdown ? (
          <div className="flex shrink-0 items-center gap-1 pt-1.5 max-md:pt-0">
            <RawMarkdownButton onPress={onOpenRawMarkdown} />
          </div>
        ) : null}
      </div>

      <TagInput
        label="Tags"
        values={tags}
        readOnlyValues={derivedTags}
        suggestions={tagSuggestions}
        onSuggestionQueryChange={onTagSuggestionQueryChange}
        suggestionsLoading={tagSuggestionsLoading}
        suggestionsError={tagSuggestionsError}
        onRetrySuggestions={onRetryTagSuggestions}
        onChange={onTagsChange}
        onBlur={flush}
        placeholder="Add tag..."
        className="mt-2 max-md:mt-0 max-md:w-full"
      />

      {(aliases.length > 0 || tags.length > 0) && (
        <TagInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          onBlur={flush}
          placeholder="Add alias..."
          className="mt-2 max-md:mt-0 max-md:w-full"
        />
      )}
    </div>
  );
}
